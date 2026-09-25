export interface Version {
  t: number
  c: number
  n: string
}

export type Liveness = 'alive' | 'suspect' | 'dead'
export type MemberState = 'active' | 'leaving'
export type Consistency = 'one' | 'quorum' | 'all'
export type RaftRole = 'follower' | 'candidate' | 'leader'
export type EventLevel = 'info' | 'success' | 'warn' | 'error'

export interface BucketPolicy {
  name: string
  n: number
  w: number
  r: number
  sloppy: boolean
}

export interface Member {
  id: string
  state: MemberState
  joinedEpoch: number
}

export interface ClusterConfig {
  epoch: number
  members: Record<string, Member>
  ring: string[]
  prevRing: string[] | null
  buckets: Record<string, BucketPolicy>
}

export interface Tunables {
  chunkSizeKB: number
  hintTtlMs: number
  gcGraceMs: number
  rebalanceKBps: number
  antiEntropyPartitionsPerTick: number
  scrubChunksPerTick: number
  suspectAfterMs: number
  deadAfterMs: number
  rpcTimeoutMs: number
  maxInflight: number
}

export interface VaultEvent {
  id: number
  ts: number
  level: EventLevel
  kind: string
  message: string
  nodes?: string[]
}

export interface NodeSnapshot {
  id: string
  up: boolean
  member: MemberState | 'removed'
  liveness: Liveness
  group: number | null
  primaryPartitions: number
  replicaPartitions: number
  objects: number
  tombstones: number
  chunks: number
  bytes: number
  hints: number
  hintBytes: number
  inflight: number
  slowMs: number
  clockSkewMs: number
  latentCorruptions: number
}

export interface PartitionSnapshot {
  id: number
  owners: string[]
  health: 'healthy' | 'degraded' | 'unavailable' | 'moving'
  aliveReplicas: number
  inSync: boolean
  keys: number
}

export interface RaftNodeSnapshot {
  id: string
  up: boolean
  role: RaftRole
  term: number
  commitIndex: number
  logLength: number
  votedFor: string | null
  leaderId: string | null
  group: number | null
}

export interface RaftLogEntrySnapshot {
  index: number
  term: number
  summary: string
}

export interface MetricsPoint {
  ts: number
  puts: number
  gets: number
  deletes: number
  errors: number
  p50: number
  p99: number
}

export interface WorkloadState {
  enabled: boolean
  bucket: string
  rate: number
  readRatio: number
  keySpace: number
  minSizeKB: number
  maxSizeKB: number
}

export interface ScenarioStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'done' | 'failed'
  detail?: string
}

export interface ScenarioResult {
  passed: boolean
  ackedWrites: number
  verified: number
  lost: number
  corruptServed: number
  unavailable: number
  convergeMs: number | null
  repairs: {
    readRepair: number
    antiEntropy: number
    scrub: number
    hintsDelivered: number
  }
}

export interface ScenarioState {
  running: boolean
  startedAt: number | null
  finishedAt: number | null
  steps: ScenarioStep[]
  result: ScenarioResult | null
  error: string | null
}

export interface ClusterSnapshot {
  now: number
  epoch: number
  configSource: 'live' | 'cached'
  metadataLeader: string | null
  metadataTerm: number
  partitionCount: number
  nodes: NodeSnapshot[]
  partitions: PartitionSnapshot[]
  livenessMatrix: { from: string; to: string; state: Liveness }[]
  networkGroups: string[][] | null
  raft: RaftNodeSnapshot[]
  raftLog: RaftLogEntrySnapshot[]
  buckets: (BucketPolicy & { objects: number; logicalBytes: number })[]
  tunables: Tunables
  rebalance: {
    active: boolean
    movingPartitions: number
    donePartitions: number
    bytesMoved: number
    keysMoved: number
    startedAt: number | null
  }
  counters: {
    putsOk: number
    putsFailed: number
    getsOk: number
    getsFailed: number
    notFound: number
    readRepairs: number
    antiEntropyRepairs: number
    antiEntropyComparisons: number
    antiEntropyRootMatches: number
    scrubRepairs: number
    scrubbedChunks: number
    corruptionsDetected: number
    hintsStored: number
    hintsDelivered: number
    hintsExpired: number
    tombstonesCollected: number
    overloadRejections: number
    lwwSuperseded: number
  }
  storage: {
    logicalBytes: number
    physicalBytes: number
    hintBytes: number
    objects: number
  }
  metrics: MetricsPoint[]
  latency: { p50: number; p99: number }
  hintsPending: number
  latentCorruptions: number
  converged: boolean
  events: VaultEvent[]
  workload: WorkloadState
  scenario: ScenarioState
  ledgerSize: number
}

export interface WriteAck {
  node: string
  kind: 'replica' | 'hint'
  for?: string
  ms: number
}

export interface WriteFailure {
  node: string
  error: string
}

export interface ObjectListing {
  bucket: string
  key: string
  size: number
  version: string
  versionTs: number
  deleted: boolean
  contentType: string
  chunks: number
  sha256: string
  preferenceList: string[]
  holders: { node: string; version: string; latest: boolean; corruptChunks: number }[]
  replicasWithLatest: number
  n: number
}
