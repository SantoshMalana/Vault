import { randomBytes } from 'node:crypto'
import {
  antiEntropyTick,
  cleanupTick,
  detectorTick,
  hintsTick,
  rebalanceTick,
  scrubTick,
} from './background'
import { getObject, putObject } from './coordinator'
import { Network } from './network'
import { describeCommand, RaftNode, type RaftCommand } from './raft'
import { initialRing, movingPartitions, PARTITION_COUNT, preferenceList } from './ring'
import { createScenario, type ScenarioRunner } from './scenario'
import { StorageNode, type Manifest } from './storage-node'
import type {
  BucketPolicy,
  ClusterConfig,
  ClusterSnapshot,
  EventLevel,
  Liveness,
  MetricsPoint,
  Tunables,
  VaultEvent,
  Version,
  WorkloadState,
} from './types'
import { compareVersions, percentile, pick, randInt, VaultError } from './util'

const ENGINE_VERSION = 7
const INITIAL_STORAGE_NODES = 5
const METADATA_NODES = ['meta-1', 'meta-2', 'meta-3']

export const DEFAULT_TUNABLES: Tunables = {
  chunkSizeKB: 16,
  hintTtlMs: 120_000,
  gcGraceMs: 180_000,
  rebalanceKBps: 2048,
  antiEntropyPartitionsPerTick: 4,
  scrubChunksPerTick: 48,
  suspectAfterMs: 500,
  deadAfterMs: 1500,
  rpcTimeoutMs: 150,
  maxInflight: 64,
}

const counterKeys = [
  'putsOk',
  'putsFailed',
  'getsOk',
  'getsFailed',
  'notFound',
  'readRepairs',
  'antiEntropyRepairs',
  'antiEntropyComparisons',
  'antiEntropyRootMatches',
  'scrubRepairs',
  'scrubbedChunks',
  'corruptionsDetected',
  'hintsStored',
  'hintsDelivered',
  'hintsExpired',
  'tombstonesCollected',
  'overloadRejections',
  'lwwSuperseded',
] as const

type Counters = Record<(typeof counterKeys)[number], number>

class Metrics {
  history: MetricsPoint[] = []
  private current = this.blank()
  private latencies: number[][] = []

  constructor(private readonly counters: Counters) {}

  private blank() {
    return { puts: 0, gets: 0, deletes: 0, errors: 0, lat: [] as number[] }
  }

  record(kind: 'put' | 'get' | 'delete', ok: boolean, ms: number) {
    if (kind === 'put') this.current.puts += 1
    else if (kind === 'get') this.current.gets += 1
    else this.current.deletes += 1
    if (!ok) this.current.errors += 1
    this.current.lat.push(ms)
    if (kind === 'get') ok ? this.counters.getsOk++ : this.counters.getsFailed++
    else ok ? this.counters.putsOk++ : this.counters.putsFailed++
  }

  roll() {
    const lat = [...this.current.lat].sort((a, b) => a - b)
    this.latencies.push(lat)
    if (this.latencies.length > 10) this.latencies.shift()
    this.history.push({
      ts: Date.now(),
      puts: this.current.puts,
      gets: this.current.gets,
      deletes: this.current.deletes,
      errors: this.current.errors,
      p50: percentile(lat, 50),
      p99: percentile(lat, 99),
    })
    if (this.history.length > 60) this.history.shift()
    this.current = this.blank()
  }

  window() {
    const all = this.latencies.flat().sort((a, b) => a - b)
    return { p50: percentile(all, 50), p99: percentile(all, 99) }
  }
}

export interface RebalanceState {
  active: boolean
  epoch: number
  moving: number
  done: Set<number>
  bytesMoved: number
  keysMoved: number
  startedAt: number | null
  finishRequestedAt: number
}

interface LedgerEntry {
  version: Version
  sha256: string
  deleted: boolean
}

export class Cluster {
  readonly engineVersion = ENGINE_VERSION
  readonly nodes = new Map<string, StorageNode>()
  readonly raft = new Map<string, RaftNode>()
  readonly net: Network
  readonly counters: Counters = Object.fromEntries(counterKeys.map((k) => [k, 0])) as Counters
  readonly metrics = new Metrics(this.counters)
  readonly ledger = new Map<string, LedgerEntry>()
  readonly retiring = new Set<string>()
  tunables: Tunables = { ...DEFAULT_TUNABLES }
  config: ClusterConfig
  configSource: 'live' | 'cached' = 'live'
  rebalance: RebalanceState = {
    active: false,
    epoch: 0,
    moving: 0,
    done: new Set(),
    bytesMoved: 0,
    keysMoved: 0,
    startedAt: null,
    finishRequestedAt: 0,
  }
  workload: WorkloadState = {
    enabled: false,
    bucket: 'workload',
    rate: 30,
    readRatio: 0.5,
    keySpace: 120,
    minSizeKB: 1,
    maxSizeKB: 48,
  }
  readonly scenario: ScenarioRunner
  private events: VaultEvent[] = []
  private eventSeq = 0
  private nodeSeq = INITIAL_STORAGE_NODES
  private timers: NodeJS.Timeout[] = []
  private busy = new Set<string>()
  private workloadCarry = 0
  private workloadInflight = 0

  constructor() {
    this.net = new Network({
      isUp: (id) => this.nodes.get(id)?.up ?? this.raft.get(id)?.up ?? false,
      extraLatency: (id) => this.nodes.get(id)?.slowMs ?? 0,
      enter: (id) => {
        const node = this.nodes.get(id)
        if (!node) return
        if (node.inflight >= this.tunables.maxInflight) {
          this.counters.overloadRejections += 1
          throw new VaultError(`${id} overloaded (${node.inflight} requests queued)`, 503)
        }
        node.inflight += 1
      },
      leave: (id) => {
        const node = this.nodes.get(id)
        if (node) node.inflight = Math.max(0, node.inflight - 1)
      },
      timeoutMs: () => this.tunables.rpcTimeoutMs,
    })

    const ids = Array.from({ length: INITIAL_STORAGE_NODES }, (_, i) => `n${i + 1}`)
    for (const id of ids) this.nodes.set(id, new StorageNode(id))

    const bootstrap: ClusterConfig = {
      epoch: 1,
      members: Object.fromEntries(ids.map((id) => [id, { id, state: 'active' as const, joinedEpoch: 1 }])),
      ring: initialRing(ids),
      prevRing: null,
      buckets: {
        default: { name: 'default', n: 3, w: 2, r: 2, sloppy: true },
        strict: { name: 'strict', n: 3, w: 2, r: 2, sloppy: false },
        workload: { name: 'workload', n: 3, w: 2, r: 2, sloppy: true },
      },
    }
    this.config = bootstrap
    for (const id of METADATA_NODES) {
      this.raft.set(
        id,
        new RaftNode(
          id,
          METADATA_NODES.filter((p) => p !== id),
          this.net,
          () => this.raft,
          bootstrap,
          (level, msg) => this.emit(level, 'raft', msg, [id]),
        ),
      )
    }
    this.scenario = createScenario(this)
    this.emit('info', 'cluster', `bootstrapped ${ids.length} storage nodes, ${METADATA_NODES.length} metadata servers, ${PARTITION_COUNT} vnodes`)
    this.start()
  }

  private every(ms: number, name: string, fn: () => void | Promise<void>) {
    this.timers.push(
      setInterval(() => {
        if (this.busy.has(name)) return
        this.busy.add(name)
        Promise.resolve()
          .then(fn)
          .catch((err) => this.emit('error', name, `background ${name} failed: ${(err as Error).message}`))
          .finally(() => this.busy.delete(name))
      }, ms),
    )
  }

  private start() {
    this.every(50, 'raft', () => {
      const now = Date.now()
      for (const r of this.raft.values()) r.tick(now)
    })
    this.every(100, 'config', () => this.refreshConfig())
    this.every(200, 'detector', () => detectorTick(this))
    this.every(400, 'hints', () => hintsTick(this))
    this.every(250, 'anti-entropy', () => antiEntropyTick(this))
    this.every(300, 'scrub', () => scrubTick(this))
    this.every(200, 'rebalance', () => rebalanceTick(this))
    this.every(1000, 'cleanup', () => cleanupTick(this))
    this.every(1000, 'metrics', () => this.metrics.roll())
    this.every(100, 'workload', () => this.workloadTick())
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.scenario.cancel()
  }

  emit(level: EventLevel, kind: string, message: string, nodes?: string[]) {
    this.events.push({ id: ++this.eventSeq, ts: Date.now(), level, kind, message, nodes })
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400)
  }

  node(id: string): StorageNode {
    const node = this.nodes.get(id)
    if (!node) throw new VaultError(`unknown node ${id}`, 404)
    return node
  }

  bucketN = (bucket: string): number => this.config.buckets[bucket]?.n ?? 3

  distinctNs(): number[] {
    const ns = new Set(Object.values(this.config.buckets).map((b) => b.n))
    if (ns.size === 0) ns.add(3)
    return [...ns]
  }

  activeMembers(): string[] {
    return Object.values(this.config.members)
      .filter((m) => m.state === 'active')
      .map((m) => m.id)
  }

  leader(): RaftNode | null {
    let best: RaftNode | null = null
    for (const r of this.raft.values()) {
      if (r.up && r.role === 'leader' && (!best || r.term > best.term)) best = r
    }
    return best
  }

  private refreshConfig() {
    const leader = this.leader()
    if (!leader) {
      this.configSource = 'cached'
      return
    }
    this.configSource = 'live'
    if (leader.config.epoch !== this.config.epoch) {
      const prevEpoch = this.config.epoch
      this.config = leader.config
      for (const node of this.nodes.values()) node.invalidateMerkle()
      if (leader.config.epoch > prevEpoch) this.emit('info', 'metadata', `gateway adopted config epoch ${leader.config.epoch}`)
    }
  }

  async propose(cmd: RaftCommand) {
    const leader = this.leader()
    if (!leader) throw new VaultError('no metadata leader (Raft has no majority); membership and policy changes are frozen, data plane serves from cached config', 503)
    await leader.propose(cmd)
    this.refreshConfig()
    this.emit('info', 'raft', `committed: ${describeCommand(cmd)} (term ${leader.term})`, [leader.id])
  }

  pickCoordinator(requested?: string): StorageNode {
    if (requested && requested !== 'auto') {
      const node = this.node(requested)
      if (!node.up) throw new VaultError(`coordinator ${requested} is down`, 503)
      return node
    }
    const candidates = [...this.nodes.values()].filter((n) => n.up && this.config.members[n.id])
    const choice = pick(candidates)
    if (!choice) throw new VaultError('no live storage node can coordinate', 503)
    return choice
  }

  clusterLiveness(id: string): Liveness {
    const target = this.nodes.get(id)
    if (!target) return 'dead'
    const observers = [...this.nodes.values()].filter((n) => n.up && n.id !== id)
    if (observers.length === 0) return target.up ? 'alive' : 'dead'
    const rank = { alive: 0, suspect: 1, dead: 2 } as const
    const ranks = observers.map((o) => rank[o.viewOf(id)]).sort((a, b) => a - b)
    const median = ranks[Math.floor(ranks.length / 2)]
    return (['alive', 'suspect', 'dead'] as const)[median]
  }

  recordAck(objectId: string, manifest: Manifest) {
    const existing = this.ledger.get(objectId)
    if (existing && compareVersions(existing.version, manifest.version) > 0) {
      this.counters.lwwSuperseded += 1
      return
    }
    if (existing) this.counters.lwwSuperseded += 0
    this.ledger.set(objectId, { version: manifest.version, sha256: manifest.sha256, deleted: manifest.deleted })
  }

  removeNode(id: string) {
    if (!this.retiring.has(id)) return
    this.nodes.delete(id)
    this.retiring.delete(id)
    for (const n of this.nodes.values()) n.view.delete(id)
    this.emit('success', 'membership', `${id} fully drained and removed from the cluster`, [id])
  }

  // ----- chaos & admin -----

  kill(id: string) {
    const r = this.raft.get(id)
    if (r) {
      r.crash()
      this.emit('error', 'chaos', `killed metadata server ${id}`, [id])
      return
    }
    const node = this.node(id)
    node.up = false
    node.inflight = 0
    this.emit('error', 'chaos', `paused simulated storage node ${id}; in-memory data retained`, [id])
  }

  revive(id: string) {
    const r = this.raft.get(id)
    if (r) {
      r.restart()
      this.emit('success', 'chaos', `restarted metadata server ${id}`, [id])
      return
    }
    const node = this.node(id)
    node.up = true
    const now = Date.now()
    for (const peer of this.nodes.keys()) if (peer !== id) node.view.set(peer, { state: 'alive', lastAck: now })
    this.emit('success', 'chaos', `restarted storage node ${id}`, [id])
  }

  wipe(id: string) {
    const node = this.node(id)
    const objects = node.manifests.size
    node.wipe()
    this.emit('error', 'chaos', `wiped disk on ${id} (${objects} objects lost locally); anti-entropy will rebuild`, [id])
  }

  corrupt(id: string, count: number, objectId?: string) {
    const node = this.node(id)
    const hit: string[] = []
    for (let i = 0; i < count; i++) {
      const victim = node.corruptRandomChunk(objectId)
      if (victim) hit.push(victim)
    }
    if (hit.length === 0) throw new VaultError(`${id} has no chunks to corrupt`, 409)
    this.emit('error', 'chaos', `flipped a byte in ${hit.length} chunk${hit.length > 1 ? 's' : ''} on ${id}`, [id])
    return hit
  }

  setSlow(id: string, ms: number) {
    this.node(id).slowMs = Math.max(0, Math.min(2000, ms))
    this.emit(ms > 0 ? 'warn' : 'info', 'chaos', ms > 0 ? `${id} is now slow (+${ms}ms per request)` : `${id} latency restored`, [id])
  }

  setSkew(id: string, ms: number) {
    this.node(id).clockSkewMs = Math.max(-60_000, Math.min(60_000, ms))
    this.emit(ms !== 0 ? 'warn' : 'info', 'chaos', `${id} wall clock skewed by ${ms}ms (HLC versions still monotonic per node)`, [id])
  }

  partition(groups: string[][]) {
    const known = new Set([...this.nodes.keys(), ...this.raft.keys()])
    const cleaned = groups.map((g) => g.filter((id) => known.has(id))).filter((g) => g.length > 0)
    if (cleaned.length < 2) throw new VaultError('a partition needs at least two non-empty groups', 400)
    const listed = new Set(cleaned.flat())
    const rest = [...known].filter((id) => !listed.has(id))
    cleaned[0].push(...rest)
    this.net.groups = cleaned
    this.emit('error', 'chaos', `network partitioned: ${cleaned.map((g) => `{${g.join(', ')}}`).join(' | ')}`)
  }

  heal() {
    if (!this.net.groups) return
    this.net.groups = null
    this.emit('success', 'chaos', 'network partition healed')
  }

  async addNode() {
    const id = `n${++this.nodeSeq}`
    const node = new StorageNode(id)
    this.nodes.set(id, node)
    try {
      await this.propose({ type: 'add-node', nodeId: id })
      this.emit('info', 'membership', `${id} joined; claiming its share of the ring`, [id])
      return id
    } catch (err) {
      this.nodes.delete(id)
      throw err
    }
  }

  async decommission(id: string) {
    const member = this.config.members[id]
    if (!member) throw new VaultError(`${id} is not an active member`, 404)
    if (this.activeMembers().length - 1 < Math.max(...Object.values(this.config.buckets).map((b) => b.n), 1)) {
      throw new VaultError('cannot decommission: fewer nodes than the largest bucket N would remain', 409)
    }
    this.retiring.add(id)
    try {
      await this.propose({ type: 'decommission-node', nodeId: id })
    } catch (err) {
      this.retiring.delete(id)
      throw err
    }
    this.emit('info', 'membership', `${id} leaving; its vnodes are being handed off`, [id])
  }

  async setBucket(policy: BucketPolicy) {
    if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(policy.name)) {
      throw new VaultError('bucket name must be 2-32 chars: lowercase letters, digits, dashes', 400)
    }
    const n = Math.floor(policy.n)
    const w = Math.floor(policy.w)
    const r = Math.floor(policy.r)
    const members = this.activeMembers().length
    if (n < 1 || n > members) throw new VaultError(`N must be between 1 and ${members} (active nodes)`, 400)
    if (w < 1 || w > n || r < 1 || r > n) throw new VaultError('W and R must be between 1 and N', 400)
    await this.propose({ type: 'set-bucket', policy: { name: policy.name, n, w, r, sloppy: !!policy.sloppy } })
  }

  async deleteBucket(name: string) {
    if (!this.config.buckets[name]) throw new VaultError(`bucket ${name} does not exist`, 404)
    await this.propose({ type: 'delete-bucket', name })
  }

  setTunables(patch: Partial<Tunables>) {
    const next = { ...this.tunables }
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in next) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new VaultError(`invalid tunable ${key}`, 400)
      }
      ;(next as Record<string, number>)[key] = value
    }
    const sweepMs = (PARTITION_COUNT / next.antiEntropyPartitionsPerTick) * 250
    if (next.gcGraceMs <= next.hintTtlMs + sweepMs) {
      throw new VaultError(
        `gcGraceMs must exceed hintTtlMs + one anti-entropy sweep (${next.hintTtlMs + sweepMs}ms) or deleted data can resurrect`,
        400,
      )
    }
    if (next.deadAfterMs <= next.suspectAfterMs) throw new VaultError('deadAfterMs must exceed suspectAfterMs', 400)
    if (next.chunkSizeKB > 1024) throw new VaultError('chunkSizeKB must be at most 1024', 400)
    this.tunables = next
    this.emit('info', 'config', `tunables updated: ${Object.keys(patch).join(', ')}`)
  }

  setWorkload(patch: Partial<WorkloadState>) {
    const next = { ...this.workload, ...patch }
    if (!this.config.buckets[next.bucket]) throw new VaultError(`bucket ${next.bucket} does not exist`, 400)
    next.rate = Math.max(1, Math.min(300, Math.floor(next.rate)))
    next.readRatio = Math.max(0, Math.min(1, next.readRatio))
    next.keySpace = Math.max(1, Math.min(2000, Math.floor(next.keySpace)))
    next.minSizeKB = Math.max(0, Math.min(1024, next.minSizeKB))
    next.maxSizeKB = Math.max(next.minSizeKB, Math.min(2048, next.maxSizeKB))
    const toggled = next.enabled !== this.workload.enabled
    this.workload = next
    if (toggled) {
      this.emit('info', 'workload', next.enabled ? `load generator started: ${next.rate} ops/s on "${next.bucket}"` : 'load generator stopped')
    }
  }

  private workloadTick() {
    if (!this.workload.enabled) return
    const w = this.workload
    this.workloadCarry += w.rate / 10
    const ops = Math.floor(this.workloadCarry)
    this.workloadCarry -= ops
    for (let i = 0; i < ops; i++) {
      if (this.workloadInflight >= 200) break
      const key = `obj-${String(randInt(0, w.keySpace - 1)).padStart(4, '0')}`
      this.workloadInflight += 1
      const op =
        Math.random() < w.readRatio
          ? getObject(this, w.bucket, key, { consistency: 'quorum' })
          : putObject(this, {
              bucket: w.bucket,
              key,
              data: randomBytes(Math.round(randInt(w.minSizeKB * 1024, w.maxSizeKB * 1024))),
              contentType: 'application/octet-stream',
            })
      op.catch(() => undefined).finally(() => {
        this.workloadInflight -= 1
      })
    }
  }

  // ----- snapshot -----

  latentCorruptionCount(): number {
    let total = 0
    for (const node of this.nodes.values()) total += node.latentCorruptions.size
    return total
  }

  maxN(): number {
    return Math.min(Math.max(...this.distinctNs()), Math.max(1, this.activeMembers().length))
  }

  partitionInSync(p: number): boolean {
    for (const n of this.distinctNs()) {
      const owners = preferenceList(this.config.ring, p, n).filter((id) => this.nodes.get(id)?.up)
      const roots = new Set(owners.map((id) => this.node(id).merkle(p, n, this.bucketN).root))
      if (roots.size > 1) return false
    }
    return true
  }

  isConverged(): boolean {
    if (this.config.prevRing) return false
    for (const node of this.nodes.values()) if (node.hints.size > 0) return false
    for (let p = 0; p < PARTITION_COUNT; p++) {
      for (const n of this.distinctNs()) {
        const owners = preferenceList(this.config.ring, p, n)
        if (owners.some((id) => !this.nodes.get(id)?.up)) return false
      }
      if (!this.partitionInSync(p)) return false
    }
    return true
  }

  snapshot(): ClusterSnapshot {
    const cfg = this.config
    const maxN = this.maxN()
    const quorum = Math.floor(maxN / 2) + 1
    const moving = new Set<number>()
    if (cfg.prevRing) for (const n of this.distinctNs()) for (const p of movingPartitions(cfg.prevRing, cfg.ring, n)) moving.add(p)

    const livenessCache = new Map([...this.nodes.keys()].map((id) => [id, this.clusterLiveness(id)]))

    const partitions = Array.from({ length: PARTITION_COUNT }, (_, p) => {
      const owners = preferenceList(cfg.ring, p, maxN)
      const aliveReplicas = owners.filter((id) => this.nodes.get(id)?.up && livenessCache.get(id) === 'alive').length
      const inSync = this.partitionInSync(p)
      const first = owners.find((id) => this.nodes.get(id)?.up)
      const keys = first ? this.node(first).manifestsInPartition(p, (m) => !m.deleted).length : 0
      let health: 'healthy' | 'degraded' | 'unavailable' | 'moving' = 'healthy'
      if (aliveReplicas < quorum) health = 'unavailable'
      else if (moving.has(p) && !this.rebalance.done.has(p)) health = 'moving'
      else if (aliveReplicas < owners.length || !inSync) health = 'degraded'
      return { id: p, owners, health, aliveReplicas, inSync, keys }
    })

    const buckets = Object.values(cfg.buckets).map((b) => ({ ...b, objects: 0, logicalBytes: 0 }))
    const latest = new Map<string, Manifest>()
    for (const node of this.nodes.values()) {
      for (const m of node.manifests.values()) {
        const cur = latest.get(m.id)
        if (!cur || compareVersions(m.version, cur.version) > 0) latest.set(m.id, m)
      }
    }
    let logicalBytes = 0
    let objects = 0
    for (const m of latest.values()) {
      if (m.deleted) continue
      objects += 1
      logicalBytes += m.size
      const b = buckets.find((x) => x.name === m.bucket)
      if (b) {
        b.objects += 1
        b.logicalBytes += m.size
      }
    }

    const nodes = [...this.nodes.values()]
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      .map((node) => {
        let tombstones = 0
        for (const m of node.manifests.values()) if (m.deleted) tombstones++
        return {
          id: node.id,
          up: node.up,
          member: cfg.members[node.id]?.state ?? ('removed' as const),
          liveness: livenessCache.get(node.id) ?? 'dead',
          group: this.net.groupOf(node.id),
          primaryPartitions: cfg.ring.filter((o) => o === node.id).length,
          replicaPartitions: partitions.filter((p) => p.owners.includes(node.id)).length,
          objects: node.manifests.size - tombstones,
          tombstones,
          chunks: node.chunks.size,
          bytes: node.bytes(),
          hints: node.hints.size,
          hintBytes: node.hintBytes(),
          inflight: node.inflight,
          slowMs: node.slowMs,
          clockSkewMs: node.clockSkewMs,
          latentCorruptions: node.latentCorruptions.size,
        }
      })

    const storageIds = nodes.map((n) => n.id)
    const livenessMatrix = storageIds.flatMap((from) =>
      storageIds.map((to) => ({
        from,
        to,
        state: from === to ? (this.node(from).up ? 'alive' : 'dead') : this.node(from).up ? this.node(from).viewOf(to) : ('dead' as Liveness),
      })),
    )

    const leader = this.leader()
    const raftSource = leader ?? [...this.raft.values()].find((r) => r.up) ?? [...this.raft.values()][0]
    const raftLog = raftSource.log
      .map((e, index) => ({ index, term: e.term, summary: describeCommand(e.cmd) }))
      .slice(1)
      .slice(-10)
      .reverse()

    return {
      now: Date.now(),
      epoch: cfg.epoch,
      configSource: this.configSource,
      metadataLeader: leader?.id ?? null,
      metadataTerm: Math.max(...[...this.raft.values()].map((r) => r.term)),
      partitionCount: PARTITION_COUNT,
      nodes,
      partitions,
      livenessMatrix,
      networkGroups: this.net.groups,
      raft: [...this.raft.values()].map((r) => ({
        id: r.id,
        up: r.up,
        role: r.role,
        term: r.term,
        commitIndex: r.commitIndex,
        logLength: r.log.length - 1,
        votedFor: r.votedFor,
        leaderId: r.leaderId,
        group: this.net.groupOf(r.id),
      })),
      raftLog,
      buckets,
      tunables: this.tunables,
      rebalance: {
        active: !!cfg.prevRing,
        movingPartitions: moving.size,
        donePartitions: [...this.rebalance.done].filter((p) => moving.has(p)).length,
        bytesMoved: this.rebalance.bytesMoved,
        keysMoved: this.rebalance.keysMoved,
        startedAt: this.rebalance.startedAt,
      },
      counters: { ...this.counters },
      storage: {
        logicalBytes,
        physicalBytes: nodes.reduce((s, n) => s + n.bytes, 0),
        hintBytes: nodes.reduce((s, n) => s + n.hintBytes, 0),
        objects,
      },
      metrics: this.metrics.history,
      latency: this.metrics.window(),
      hintsPending: nodes.reduce((s, n) => s + n.hints, 0),
      latentCorruptions: nodes.reduce((s, n) => s + n.latentCorruptions, 0),
      converged: this.isConverged(),
      events: this.events.slice(-150).reverse(),
      workload: this.workload,
      scenario: this.scenario.state,
      ledgerSize: this.ledger.size,
    }
  }
}

const globalForVault = globalThis as unknown as { __vault?: Cluster }

export function getCluster(): Cluster {
  if (process.env.VAULT_MODE !== 'simulator') throw new VaultError('The simulator is disabled. Use the durable API.', 404)
  const existing = globalForVault.__vault
  if (existing && existing.engineVersion === ENGINE_VERSION) return existing
  existing?.stop()
  const cluster = new Cluster()
  globalForVault.__vault = cluster
  return cluster
}

export function resetCluster(): Cluster {
  globalForVault.__vault?.stop()
  const cluster = new Cluster()
  globalForVault.__vault = cluster
  return cluster
}
