import type { Cluster } from './cluster'
import { diffMerkle, movingPartitions, PARTITION_COUNT, preferenceList } from './ring'
import type { ChunkRef, StorageNode } from './storage-node'
import { compareVersions, pick, sha256, shuffle, versionToString } from './util'

const GARBAGE_CHUNK_AGE_MS = 5000

interface SyncStats {
  match: boolean
  bucketsDiffered: number
  pushed: number
  pulled: number
  bytes: number
  truncated: boolean
}

/**
 * Compare two replicas' Merkle trees for one partition and exchange only the
 * keys in differing buckets. Newer versions win (LWW on HLC versions).
 */
export async function syncPair(
  cluster: Cluster,
  a: string,
  b: string,
  partition: number,
  n: number,
  opts: { pushOnly?: boolean; byteBudget?: number } = {},
): Promise<SyncStats> {
  const bucketN = cluster.bucketN
  const A = cluster.node(a)
  const B = cluster.node(b)
  const stats: SyncStats = { match: false, bucketsDiffered: 0, pushed: 0, pulled: 0, bytes: 0, truncated: false }
  const ma = A.merkle(partition, n, bucketN)
  const mb = await cluster.net.rpc(a, b, () => B.merkle(partition, n, bucketN))
  if (ma.root === mb.root) {
    stats.match = true
    return stats
  }
  const diff = diffMerkle(ma, mb)
  stats.bucketsDiffered = diff.length
  const ea = A.entriesInBuckets(partition, n, diff, bucketN)
  const eb = await cluster.net.rpc(a, b, () => B.entriesInBuckets(partition, n, diff, bucketN))
  const va = new Map(ea.map((e) => [e.id, e.version]))
  const vb = new Map(eb.map((e) => [e.id, e.version]))
  const ids = new Set([...va.keys(), ...vb.keys()])

  for (const id of ids) {
    if (opts.byteBudget !== undefined && stats.bytes >= opts.byteBudget) {
      stats.truncated = true
      break
    }
    const x = va.get(id)
    const y = vb.get(id)
    if (x && (!y || compareVersions(x, y) > 0)) {
      const full = A.readFull(id)
      if (!full) continue
      const res = await cluster.net.rpc(a, b, () => B.applyWrite(full.manifest, full.chunks))
      if (res === 'applied') {
        stats.pushed += 1
        stats.bytes += full.manifest.size
      }
    } else if (!opts.pushOnly && y && (!x || compareVersions(y, x) > 0)) {
      const full = await cluster.net.rpc(a, b, () => B.readFull(id))
      if (!full) continue
      if (A.applyWrite(full.manifest, full.chunks) === 'applied') {
        stats.pulled += 1
        stats.bytes += full.manifest.size
      }
    }
  }
  return stats
}

function aliveTo(cluster: Cluster, observer: StorageNode, peer: string) {
  return observer.viewOf(peer) !== 'dead' && cluster.net.canReach(observer.id, peer)
}

export function detectorTick(cluster: Cluster) {
  const now = Date.now()
  const { suspectAfterMs, deadAfterMs } = cluster.tunables
  const before = new Map([...cluster.nodes.keys()].map((id) => [id, cluster.clusterLiveness(id)]))
  const upNodes = [...cluster.nodes.values()].filter((n) => n.up)

  for (const observer of upNodes) {
    for (const peer of cluster.nodes.keys()) {
      if (peer === observer.id) continue
      let ok = cluster.net.canReach(observer.id, peer)
      if (!ok) {
        const helpers = shuffle(upNodes.filter((h) => h.id !== observer.id && h.id !== peer)).slice(0, 2)
        ok = helpers.some((h) => cluster.net.canReach(observer.id, h.id) && cluster.net.canReach(h.id, peer))
      }
      const prev = observer.view.get(peer) ?? { state: 'alive' as const, lastAck: now }
      if (ok) observer.view.set(peer, { state: 'alive', lastAck: now })
      else {
        const silentFor = now - prev.lastAck
        const state = silentFor >= deadAfterMs ? 'dead' : silentFor >= suspectAfterMs ? 'suspect' : prev.state
        observer.view.set(peer, { state, lastAck: prev.lastAck })
      }
    }
  }

  for (const [id, was] of before) {
    const is = cluster.clusterLiveness(id)
    if (was === is) continue
    const level = is === 'alive' ? 'success' : is === 'suspect' ? 'warn' : 'error'
    cluster.emit(level, 'failure-detector', `${id} is now ${is.toUpperCase()} (majority view)`, [id])
  }
}

export async function hintsTick(cluster: Cluster) {
  const now = Date.now()
  const cfg = cluster.config
  for (const holder of cluster.nodes.values()) {
    if (!holder.up) continue
    const delivered = new Map<string, number>()
    let processed = 0
    for (const hint of [...holder.hints.values()]) {
      if (hint.delivering) continue
      if (now - hint.createdAt > cluster.tunables.hintTtlMs) {
        holder.hints.delete(hint.id)
        cluster.counters.hintsExpired += 1
        cluster.emit('warn', 'hinted-handoff', `hint on ${holder.id} for ${hint.target} expired; anti-entropy will repair ${hint.manifest.id}`, [holder.id, hint.target])
        continue
      }
      if (processed >= 25) break
      const n = cluster.bucketN(hint.manifest.bucket)
      const pref = preferenceList(cfg.ring, hint.manifest.partition, n)
      const targets = pref.includes(hint.target) || !cfg.members[hint.target] ? [hint.target] : pref
      if (!targets.every((t) => cluster.nodes.has(t) && holder.viewOf(t) === 'alive' && cluster.net.canReach(holder.id, t))) continue
      hint.delivering = true
      processed += 1
      try {
        for (const target of targets) {
          await cluster.net.rpc(holder.id, target, () => cluster.node(target).applyWrite(hint.manifest, hint.chunks))
        }
        holder.hints.delete(hint.id)
        cluster.counters.hintsDelivered += 1
        for (const t of targets) delivered.set(t, (delivered.get(t) ?? 0) + 1)
      } catch {
        hint.delivering = false
      }
    }
    for (const [target, count] of delivered) {
      cluster.emit('success', 'hinted-handoff', `${holder.id} delivered ${count} hint${count > 1 ? 's' : ''} to ${target}`, [holder.id, target])
    }
  }
}

let aeCursor = 0

export async function antiEntropyTick(cluster: Cluster) {
  const cfg = cluster.config
  const per = cluster.tunables.antiEntropyPartitionsPerTick
  const partitions = Array.from({ length: per }, (_, i) => (aeCursor + i) % PARTITION_COUNT)
  aeCursor = (aeCursor + per) % PARTITION_COUNT

  for (const p of partitions) {
    for (const n of cluster.distinctNs()) {
      const owners = preferenceList(cfg.ring, p, n).filter((id) => cluster.nodes.get(id)?.up)
      const a = pick(owners)
      if (!a) continue
      const A = cluster.node(a)
      for (const b of owners) {
        if (b === a || !aliveTo(cluster, A, b)) continue
        try {
          cluster.counters.antiEntropyComparisons += 1
          const s = await syncPair(cluster, a, b, p, n)
          if (s.match) {
            cluster.counters.antiEntropyRootMatches += 1
            continue
          }
          const repaired = s.pushed + s.pulled
          if (repaired > 0) {
            cluster.counters.antiEntropyRepairs += repaired
            cluster.emit(
              'success',
              'anti-entropy',
              `vnode ${p}: ${a}↔${b} Merkle roots differed in ${s.bucketsDiffered}/16 buckets, repaired ${repaired} key${repaired > 1 ? 's' : ''}`,
              [a, b],
            )
          }
        } catch {
          // Peer unreachable mid-sync; next sweep retries.
        }
      }
    }
  }
}

async function fetchGoodChunk(cluster: Cluster, node: StorageNode, ref: ChunkRef, objectId: string, bucket: string, partition: number) {
  const n = cluster.bucketN(bucket)
  const cfg = cluster.config
  const candidates = [
    ...preferenceList(cfg.ring, partition, n),
    ...(cfg.prevRing ? preferenceList(cfg.prevRing, partition, n) : []),
  ].filter((id, i, arr) => id !== node.id && arr.indexOf(id) === i && cluster.nodes.get(id)?.up)
  for (const peer of candidates) {
    try {
      const data = await cluster.net.rpc(node.id, peer, () => cluster.node(peer).getChunk(ref.id))
      if (data && sha256(data) === ref.sha256) return { data, peer }
    } catch {
      continue
    }
  }
  return null
}

export async function scrubTick(cluster: Cluster) {
  const now = Date.now()
  const k = cluster.tunables.scrubChunksPerTick
  for (const node of cluster.nodes.values()) {
    if (!node.up) continue

    for (const chunk of node.nextScrubBatch(k)) {
      const manifest = node.manifests.get(chunk.objectId)
      if (!manifest || manifest.deleted || versionToString(manifest.version) !== chunk.version) {
        if (now - chunk.storedAt > GARBAGE_CHUNK_AGE_MS) {
          node.chunks.delete(chunk.ref.id)
          node.latentCorruptions.delete(chunk.ref.id)
        }
        continue
      }
      cluster.counters.scrubbedChunks += 1
      if (sha256(chunk.data) === chunk.ref.sha256) continue
      cluster.counters.corruptionsDetected += 1
      cluster.emit('error', 'scrub', `scrubber found bit rot in ${chunk.objectId} on ${node.id}`, [node.id])
      const good = await fetchGoodChunk(cluster, node, chunk.ref, chunk.objectId, manifest.bucket, manifest.partition)
      if (good && node.up) {
        node.repairChunk(chunk.ref, good.data, chunk.objectId, chunk.version)
        cluster.counters.scrubRepairs += 1
        cluster.emit('success', 'scrub', `re-replicated chunk of ${chunk.objectId} to ${node.id} from ${good.peer}`, [node.id, good.peer])
      }
    }

    for (const manifest of node.nextManifestBatch(Math.max(8, Math.floor(k / 2)))) {
      if (manifest.deleted) {
        if (now - manifest.writtenAt > cluster.tunables.gcGraceMs) {
          node.deleteManifest(manifest.id)
          cluster.counters.tombstonesCollected += 1
        }
        continue
      }
      for (const ref of manifest.chunks) {
        if (node.chunks.has(ref.id)) continue
        const good = await fetchGoodChunk(cluster, node, ref, manifest.id, manifest.bucket, manifest.partition)
        if (good && node.up) {
          node.repairChunk(ref, good.data, manifest.id, versionToString(manifest.version))
          cluster.counters.scrubRepairs += 1
          cluster.emit('success', 'scrub', `restored missing chunk of ${manifest.id} on ${node.id} from ${good.peer}`, [node.id, good.peer])
        }
      }
    }
  }
}

export async function rebalanceTick(cluster: Cluster) {
  const cfg = cluster.config
  const rb = cluster.rebalance
  if (!cfg.prevRing) {
    rb.active = false
    return
  }
  if (rb.epoch !== cfg.epoch) {
    rb.epoch = cfg.epoch
    rb.done = new Set()
    rb.active = true
    rb.startedAt = rb.startedAt ?? Date.now()
    rb.finishRequestedAt = 0
  }

  const ns = cluster.distinctNs()
  const moving = new Set<number>()
  for (const n of ns) for (const p of movingPartitions(cfg.prevRing, cfg.ring, n)) moving.add(p)
  rb.moving = moving.size

  let budget = (cluster.tunables.rebalanceKBps * 1024 * 200) / 1000
  for (const p of moving) {
    if (rb.done.has(p) || budget <= 0) continue
    let complete = true
    for (const n of ns) {
      const oldPref = preferenceList(cfg.prevRing, p, n)
      const newPref = preferenceList(cfg.ring, p, n)
      const targets = newPref.filter((id) => !oldPref.includes(id))
      const minW = Math.min(...Object.values(cfg.buckets).filter((b) => b.n === n).map((b) => b.w), n)
      for (const target of targets) {
        const T = cluster.nodes.get(target)
        if (!T?.up) {
          complete = false
          continue
        }
        const sources = [...new Set([...oldPref, ...newPref])].filter(
          (id) => id !== target && cluster.nodes.get(id)?.up && cluster.net.canReach(id, target),
        )
        const reachableOld = oldPref.filter((id) => sources.includes(id)).length
        if (reachableOld < n - minW + 1) complete = false
        for (const source of sources) {
          try {
            const s = await syncPair(cluster, source, target, p, n, { pushOnly: true, byteBudget: budget })
            budget -= s.bytes
            rb.bytesMoved += s.bytes
            rb.keysMoved += s.pushed
            if (s.pushed > 0 || s.truncated) complete = false
          } catch {
            complete = false
          }
        }
      }
    }
    if (complete) rb.done.add(p)
  }

  if (rb.done.size >= moving.size && Date.now() - rb.finishRequestedAt > 1500) {
    rb.finishRequestedAt = Date.now()
    try {
      await cluster.propose({ type: 'finish-rebalance', epoch: cfg.epoch })
      const took = rb.startedAt ? Date.now() - rb.startedAt : 0
      cluster.emit('success', 'rebalance', `rebalance complete: ${moving.size}/64 vnodes moved, ${rb.keysMoved} keys, ${(rb.bytesMoved / 1024).toFixed(0)} KB in ${(took / 1000).toFixed(1)}s`)
      rb.startedAt = null
      rb.bytesMoved = 0
      rb.keysMoved = 0
    } catch (err) {
      cluster.emit('warn', 'rebalance', `rebalance data moved but metadata commit failed: ${(err as Error).message}`)
    }
  }
}

/** After a rebalance commits, non-owners hand off any copies and then drop them. */
export async function cleanupTick(cluster: Cluster) {
  const cfg = cluster.config
  if (cfg.prevRing) return
  for (const node of [...cluster.nodes.values()]) {
    if (!node.up) continue
    const isMember = !!cfg.members[node.id]
    let handled = 0
    for (const manifest of [...node.manifests.values()]) {
      if (handled >= 40) break
      const n = cluster.bucketN(manifest.bucket)
      const pref = preferenceList(cfg.ring, manifest.partition, n)
      if (isMember && pref.includes(node.id)) continue
      handled += 1
      const full = node.readFull(manifest.id)
      let confirmed = 0
      for (const owner of pref) {
        if (!cluster.nodes.get(owner)?.up || !cluster.net.canReach(node.id, owner)) continue
        try {
          if (full) await cluster.net.rpc(node.id, owner, () => cluster.node(owner).applyWrite(full.manifest, full.chunks))
          else {
            const theirs = await cluster.net.rpc(node.id, owner, () => cluster.node(owner).getManifest(manifest.id))
            if (!theirs || compareVersions(theirs.version, manifest.version) < 0) continue
          }
          confirmed += 1
        } catch {
          // Owner not reachable right now.
        }
      }
      if (confirmed >= pref.length) node.deleteManifest(manifest.id)
    }
    if (!isMember && node.manifests.size === 0 && node.hints.size === 0) {
      cluster.removeNode(node.id)
    }
  }
}
