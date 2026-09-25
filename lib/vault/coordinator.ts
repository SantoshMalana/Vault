import type { Cluster } from './cluster'
import { partitionOf, preferenceList, ringWalk } from './ring'
import type { ChunkPayload, ChunkRef, Manifest, StorageNode } from './storage-node'
import type { Consistency, ObjectListing, WriteAck, WriteFailure } from './types'
import { compareVersions, errorMessage, sha256, sleep, VaultError, versionToString } from './util'

export const MAX_OBJECT_BYTES = 8 * 1024 * 1024
const KEY_PATTERN = /^[A-Za-z0-9._\-/]{1,256}$/

export interface PutInput {
  bucket: string
  key: string
  data: Buffer
  contentType?: string
  coordinator?: string
  deleted?: boolean
}

export interface PutResult {
  objectId: string
  version: string
  coordinator: string
  partition: number
  preferenceList: string[]
  n: number
  w: number
  acks: WriteAck[]
  failures: WriteFailure[]
  bytes: number
  chunks: number
  latencyMs: number
}

export interface GetResult {
  manifest: Manifest
  data: Buffer
  coordinator: string
  r: number
  servedBy: string[]
  staleReplicas: string[]
  corruptReplicas: string[]
  latencyMs: number
}

function validateKey(bucket: string, key: string) {
  if (!KEY_PATTERN.test(key) || key.includes('..')) {
    throw new VaultError('object key must be 1-256 chars of [A-Za-z0-9._-/]', 400)
  }
  if (!bucket) throw new VaultError('bucket is required', 400)
}

function withCoordinator<T>(cluster: Cluster, requested: string | undefined, fn: (coord: StorageNode) => Promise<T>) {
  const coord = cluster.pickCoordinator(requested)
  if (coord.inflight >= cluster.tunables.maxInflight) {
    cluster.counters.overloadRejections += 1
    throw new VaultError(`coordinator ${coord.id} overloaded (${coord.inflight} in flight); backing off`, 503)
  }
  coord.inflight += 1
  return fn(coord).finally(() => {
    coord.inflight -= 1
  })
}

export async function putObject(cluster: Cluster, input: PutInput): Promise<PutResult> {
  const started = Date.now()
  const kind = input.deleted ? 'delete' : 'put'
  try {
    validateKey(input.bucket, input.key)
    if (input.data.length > MAX_OBJECT_BYTES) throw new VaultError('object exceeds 8 MB limit', 413)
    const cfg = cluster.config
    const policy = cfg.buckets[input.bucket]
    if (!policy) throw new VaultError(`bucket "${input.bucket}" does not exist`, 404)

    const result = await withCoordinator(cluster, input.coordinator, async (coord) => {
      const objectId = `${input.bucket}/${input.key}`
      const partition = partitionOf(objectId)
      const version = coord.clock.now()
      const vs = versionToString(version)
      const chunkSize = cluster.tunables.chunkSizeKB * 1024

      const payload: ChunkPayload[] = []
      if (!input.deleted) {
        const count = Math.max(1, Math.ceil(input.data.length / chunkSize))
        for (let i = 0; i < count; i++) {
          const data = input.data.subarray(i * chunkSize, (i + 1) * chunkSize)
          const ref: ChunkRef = { id: `${objectId}@${vs}#${i}`, sha256: sha256(data), size: data.length }
          payload.push({ ref, data })
        }
      }

      const manifest: Manifest = {
        id: objectId,
        bucket: input.bucket,
        key: input.key,
        partition,
        version,
        deleted: !!input.deleted,
        size: input.deleted ? 0 : input.data.length,
        sha256: input.deleted ? '' : sha256(input.data),
        contentType: input.contentType || 'application/octet-stream',
        chunks: payload.map((c) => c.ref),
        writtenAt: Date.now(),
      }

      const pref = preferenceList(cfg.ring, partition, policy.n)
      if (pref.length < policy.w) throw new VaultError(`only ${pref.length} nodes in ring; W=${policy.w}`, 503)
      const fallbacks = ringWalk(cfg.ring, partition).filter((id) => !pref.includes(id))
      const claimed = new Set<string>()
      const acks: WriteAck[] = []
      const failures: WriteFailure[] = []

      const attempt = async (target: string): Promise<WriteAck> => {
        const t0 = Date.now()
        const view = coord.viewOf(target)
        if (view !== 'dead') {
          try {
            await cluster.net.rpc(coord.id, target, () => cluster.node(target).applyWrite(manifest, payload))
            return { node: target, kind: 'replica', ms: Date.now() - t0 }
          } catch (err) {
            if (!policy.sloppy) throw err
          }
        } else if (!policy.sloppy) {
          throw new VaultError(`${target} marked dead by ${coord.id}'s failure detector`, 503)
        }
        for (const fb of fallbacks) {
          if (claimed.has(fb) || coord.viewOf(fb) === 'dead') continue
          claimed.add(fb)
          try {
            await cluster.net.rpc(coord.id, fb, () => cluster.node(fb).storeHint(target, manifest, payload))
            cluster.counters.hintsStored += 1
            return { node: fb, kind: 'hint', for: target, ms: Date.now() - t0 }
          } catch {
            continue
          }
        }
        throw new VaultError(`no replica or hinted-handoff fallback reachable for ${target}`, 503)
      }

      await new Promise<void>((resolve, reject) => {
        let settled = false
        let remaining = pref.length
        const check = () => {
          if (settled) return
          if (acks.length >= policy.w) {
            settled = true
            resolve()
          } else if (acks.length + remaining < policy.w) {
            settled = true
            reject(
              new VaultError(
                `write quorum not met: ${acks.length}/${policy.w} acks (${failures.map((f) => `${f.node}: ${f.error}`).join('; ')})`,
                503,
                { acks, failures },
              ),
            )
          }
        }
        for (const target of pref) {
          attempt(target)
            .then((ack) => acks.push(ack))
            .catch((err) => failures.push({ node: target, error: errorMessage(err) }))
            .finally(() => {
              remaining -= 1
              check()
            })
        }
      })

      cluster.recordAck(objectId, manifest)
      return {
        objectId,
        version: vs,
        coordinator: coord.id,
        partition,
        preferenceList: pref,
        n: policy.n,
        w: policy.w,
        acks: [...acks],
        failures: [...failures],
        bytes: manifest.size,
        chunks: payload.length,
        latencyMs: Date.now() - started,
      }
    })
    cluster.metrics.record(kind, true, Date.now() - started)
    return result
  } catch (err) {
    cluster.metrics.record(kind, false, Date.now() - started)
    throw err
  }
}

export function deleteObject(cluster: Cluster, bucket: string, key: string, coordinator?: string) {
  return putObject(cluster, { bucket, key, data: Buffer.alloc(0), coordinator, deleted: true })
}

interface ManifestResponse {
  node: string
  manifest: Manifest | null
}

export async function getObject(
  cluster: Cluster,
  bucket: string,
  key: string,
  opts: { consistency?: Consistency; coordinator?: string } = {},
): Promise<GetResult> {
  const started = Date.now()
  try {
    validateKey(bucket, key)
    const cfg = cluster.config
    const policy = cfg.buckets[bucket]
    if (!policy) throw new VaultError(`bucket "${bucket}" does not exist`, 404)
    const consistency = opts.consistency ?? 'quorum'
    const r = consistency === 'one' ? 1 : consistency === 'all' ? policy.n : policy.r

    const result = await withCoordinator(cluster, opts.coordinator, async (coord) => {
      const objectId = `${bucket}/${key}`
      const partition = partitionOf(objectId)
      const pref = preferenceList(cfg.ring, partition, policy.n)
      const responses: ManifestResponse[] = []
      const failures: WriteFailure[] = []

      const ask = (node: string) =>
        coord.viewOf(node) === 'dead'
          ? Promise.reject(new VaultError(`${node} marked dead`, 503))
          : cluster.net.rpc(coord.id, node, () => cluster.node(node).getManifest(objectId))

      const allSettled = Promise.allSettled(
        pref.map((node) =>
          ask(node).then(
            (manifest) => responses.push({ node, manifest }),
            (err) => failures.push({ node, error: errorMessage(err) }),
          ),
        ),
      )

      await new Promise<void>((resolve, reject) => {
        const poll = () => {
          if (responses.length >= r) return resolve()
          if (responses.length + (pref.length - responses.length - failures.length) < r) {
            return reject(
              new VaultError(
                `read quorum not met: ${responses.length}/${r} replicas answered (${failures.map((f) => `${f.node}: ${f.error}`).join('; ')})`,
                503,
              ),
            )
          }
          setTimeout(poll, 1)
        }
        poll()
      })

      const quorumResponses = [...responses]
      let best = latest(quorumResponses)

      if (!best && cfg.prevRing) {
        const oldOwners = preferenceList(cfg.prevRing, partition, policy.n).filter((n) => !pref.includes(n))
        const extra = await Promise.allSettled(oldOwners.map((node) => ask(node).then((manifest) => ({ node, manifest }))))
        for (const e of extra) if (e.status === 'fulfilled') quorumResponses.push(e.value)
        best = latest(quorumResponses)
      }

      const staleReplicas = quorumResponses
        .filter((resp) => best && (!resp.manifest || compareVersions(resp.manifest.version, best.version) < 0))
        .map((resp) => resp.node)

      void allSettled.then(() => {
        const finalBest = latest(responses) ?? best
        if (!finalBest) return
        const stale = responses.filter(
          (resp) => !resp.manifest || compareVersions(resp.manifest.version, finalBest.version) < 0,
        )
        const source = responses.find(
          (resp) => resp.manifest && compareVersions(resp.manifest.version, finalBest.version) === 0,
        )
        if (source) for (const s of stale) void readRepair(cluster, coord.id, source.node, s.node, objectId)
      })

      if (!best || best.deleted) {
        throw new VaultError(best?.deleted ? 'object deleted (tombstone)' : 'object not found', 404, {
          r,
          answered: quorumResponses.map((x) => x.node),
        })
      }

      const holders = quorumResponses
        .filter((resp) => resp.manifest && compareVersions(resp.manifest.version, best!.version) === 0)
        .map((resp) => resp.node)
        .sort((a, b) => (a === coord.id ? -1 : b === coord.id ? 1 : 0))

      const corrupt = new Set<string>()
      const servedBy = new Set<string>()
      const parts: Buffer[] = []

      for (const ref of best.chunks) {
        let good: Buffer | null = null
        for (const holder of holders) {
          try {
            const data = await cluster.net.rpc(coord.id, holder, () => cluster.node(holder).getChunk(ref.id))
            if (!data) continue
            if (sha256(data) !== ref.sha256) {
              corrupt.add(holder)
              cluster.counters.corruptionsDetected += 1
              cluster.emit('error', 'corruption', `checksum mismatch on read: ${ref.id.split('@')[0]} chunk on ${holder}`, [holder])
              continue
            }
            good = data
            servedBy.add(holder)
            for (const bad of corrupt) void pushChunk(cluster, coord.id, bad, ref, data, objectId, versionToString(best.version))
            break
          } catch {
            continue
          }
        }
        if (!good) throw new VaultError(`no intact replica for chunk ${ref.id}; unrecoverable from read quorum`, 500)
        parts.push(good)
      }

      const data = Buffer.concat(parts)
      if (sha256(data) !== best.sha256) throw new VaultError('assembled object failed whole-object checksum', 500)

      return {
        manifest: best,
        data,
        coordinator: coord.id,
        r,
        servedBy: [...servedBy],
        staleReplicas,
        corruptReplicas: [...corrupt],
        latencyMs: Date.now() - started,
      }
    })
    cluster.metrics.record('get', true, Date.now() - started)
    return result
  } catch (err) {
    if (err instanceof VaultError && err.status === 404) {
      cluster.counters.notFound += 1
      cluster.metrics.record('get', true, Date.now() - started)
    } else {
      cluster.metrics.record('get', false, Date.now() - started)
    }
    throw err
  }
}

function latest(responses: ManifestResponse[]): Manifest | null {
  let best: Manifest | null = null
  for (const r of responses) {
    if (r.manifest && (!best || compareVersions(r.manifest.version, best.version) > 0)) best = r.manifest
  }
  return best
}

async function readRepair(cluster: Cluster, coordId: string, source: string, target: string, objectId: string) {
  try {
    const full = await cluster.net.rpc(coordId, source, () => cluster.node(source).readFull(objectId))
    if (!full) return
    const res = await cluster.net.rpc(coordId, target, () => cluster.node(target).applyWrite(full.manifest, full.chunks))
    if (res === 'applied') {
      cluster.counters.readRepairs += 1
      cluster.emit('success', 'read-repair', `read-repair pushed ${objectId} to stale replica ${target}`, [target])
    }
  } catch {
    // Anti-entropy will catch whatever read-repair could not fix.
  }
}

async function pushChunk(
  cluster: Cluster,
  coordId: string,
  target: string,
  ref: ChunkRef,
  data: Buffer,
  objectId: string,
  version: string,
) {
  try {
    await sleep(0)
    await cluster.net.rpc(coordId, target, () => cluster.node(target).repairChunk(ref, data, objectId, version))
    cluster.counters.readRepairs += 1
    cluster.emit('success', 'read-repair', `replaced corrupt chunk of ${objectId} on ${target}`, [target])
  } catch {
    // Scrubber retries.
  }
}

/** Admin scan across all live nodes, used by the object browser. */
export function listObjects(cluster: Cluster, bucket: string, includeDeleted = false): ObjectListing[] {
  const cfg = cluster.config
  const policy = cfg.buckets[bucket]
  if (!policy) throw new VaultError(`bucket "${bucket}" does not exist`, 404)
  const byId = new Map<string, { best: Manifest; holders: { node: string; manifest: Manifest }[] }>()
  for (const node of cluster.nodes.values()) {
    if (!node.up) continue
    for (const m of node.manifests.values()) {
      if (m.bucket !== bucket) continue
      const entry = byId.get(m.id)
      if (!entry) byId.set(m.id, { best: m, holders: [{ node: node.id, manifest: m }] })
      else {
        entry.holders.push({ node: node.id, manifest: m })
        if (compareVersions(m.version, entry.best.version) > 0) entry.best = m
      }
    }
  }
  const out: ObjectListing[] = []
  for (const { best, holders } of byId.values()) {
    if (best.deleted && !includeDeleted) continue
    const pref = preferenceList(cfg.ring, best.partition, policy.n)
    const holderInfo = holders.map((h) => {
      const node = cluster.node(h.node)
      const latestHere = compareVersions(h.manifest.version, best.version) === 0
      const corruptChunks = h.manifest.chunks.filter((ref) => !node.hasValidChunk(ref)).length
      return { node: h.node, version: versionToString(h.manifest.version), latest: latestHere, corruptChunks }
    })
    out.push({
      bucket,
      key: best.key,
      size: best.size,
      version: versionToString(best.version),
      versionTs: best.version.t,
      deleted: best.deleted,
      contentType: best.contentType,
      chunks: best.chunks.length,
      sha256: best.sha256,
      preferenceList: pref,
      holders: holderInfo.sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true })),
      replicasWithLatest: holderInfo.filter((h) => h.latest && h.corruptChunks === 0 && pref.includes(h.node)).length,
      n: policy.n,
    })
  }
  return out.sort((a, b) => b.versionTs - a.versionTs).slice(0, 500)
}
