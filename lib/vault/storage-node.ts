import { buildMerkle, merkleBucket, type MerkleSummary } from './ring'
import type { Liveness, Version } from './types'
import { compareVersions, HybridClock, sha256, VaultError, versionToString } from './util'

export interface ChunkRef {
  id: string
  sha256: string
  size: number
}

export interface Manifest {
  id: string
  bucket: string
  key: string
  partition: number
  version: Version
  deleted: boolean
  size: number
  sha256: string
  contentType: string
  chunks: ChunkRef[]
  writtenAt: number
}

export interface ChunkPayload {
  ref: ChunkRef
  data: Buffer
}

export interface StoredChunk {
  ref: ChunkRef
  data: Buffer
  objectId: string
  version: string
  storedAt: number
}

export interface Hint {
  id: string
  target: string
  manifest: Manifest
  chunks: ChunkPayload[]
  createdAt: number
  delivering: boolean
}

export interface PeerView {
  state: Liveness
  lastAck: number
}

export type ApplyResult = 'applied' | 'stale'

export class StorageNode {
  up = true
  slowMs = 0
  clockSkewMs = 0
  inflight = 0
  readonly clock: HybridClock
  readonly manifests = new Map<string, Manifest>()
  readonly chunks = new Map<string, StoredChunk>()
  readonly hints = new Map<string, Hint>()
  readonly view = new Map<string, PeerView>()
  readonly latentCorruptions = new Set<string>()
  private merkleCache = new Map<string, MerkleSummary>()
  private scrubQueue: string[] = []
  private manifestQueue: string[] = []

  constructor(readonly id: string) {
    this.clock = new HybridClock(id, () => this.clockSkewMs)
  }

  viewOf(peer: string): Liveness {
    if (peer === this.id) return this.up ? 'alive' : 'dead'
    return this.view.get(peer)?.state ?? 'alive'
  }

  invalidateMerkle() {
    this.merkleCache.clear()
  }

  /** Chunks are written first; the manifest write is the commit point. */
  applyWrite(manifest: Manifest, payload: ChunkPayload[]): ApplyResult {
    this.clock.observe(manifest.version)
    const current = this.manifests.get(manifest.id)
    if (current && compareVersions(current.version, manifest.version) >= 0) return 'stale'

    const supplied = new Map(payload.map((c) => [c.ref.id, c]))
    if (!manifest.deleted) {
      for (const ref of manifest.chunks) {
        const chunk = supplied.get(ref.id)
        if (chunk) {
          if (sha256(chunk.data) !== ref.sha256) {
            throw new VaultError(`checksum mismatch on ingest for ${ref.id}`, 422)
          }
        } else if (!this.hasValidChunk(ref)) {
          throw new VaultError(`missing chunk ${ref.id}; refusing to commit manifest`, 409)
        }
      }
      const vs = versionToString(manifest.version)
      const now = Date.now()
      for (const chunk of supplied.values()) {
        this.chunks.set(chunk.ref.id, {
          ref: chunk.ref,
          data: Buffer.from(chunk.data),
          objectId: manifest.id,
          version: vs,
          storedAt: now,
        })
        this.latentCorruptions.delete(chunk.ref.id)
      }
    }
    this.manifests.set(manifest.id, { ...manifest, writtenAt: manifest.writtenAt })
    this.dirty(manifest.partition)
    return 'applied'
  }

  storeHint(target: string, manifest: Manifest, chunks: ChunkPayload[]): void {
    this.clock.observe(manifest.version)
    const id = `${target}|${manifest.id}|${versionToString(manifest.version)}`
    this.hints.set(id, {
      id,
      target,
      manifest,
      chunks: chunks.map((c) => ({ ref: c.ref, data: Buffer.from(c.data) })),
      createdAt: Date.now(),
      delivering: false,
    })
  }

  getManifest(objectId: string): Manifest | null {
    return this.manifests.get(objectId) ?? null
  }

  getChunk(chunkId: string): Buffer | null {
    const chunk = this.chunks.get(chunkId)
    return chunk ? Buffer.from(chunk.data) : null
  }

  hasValidChunk(ref: ChunkRef): boolean {
    const chunk = this.chunks.get(ref.id)
    return !!chunk && sha256(chunk.data) === ref.sha256
  }

  /** Returns the manifest plus its verified chunk data, or null if any chunk is missing/corrupt. */
  readFull(objectId: string): { manifest: Manifest; chunks: ChunkPayload[] } | null {
    const manifest = this.manifests.get(objectId)
    if (!manifest) return null
    const chunks: ChunkPayload[] = []
    if (!manifest.deleted) {
      for (const ref of manifest.chunks) {
        const chunk = this.chunks.get(ref.id)
        if (!chunk || sha256(chunk.data) !== ref.sha256) return null
        chunks.push({ ref, data: Buffer.from(chunk.data) })
      }
    }
    return { manifest, chunks }
  }

  repairChunk(ref: ChunkRef, data: Buffer, objectId: string, version: string) {
    if (sha256(data) !== ref.sha256) throw new VaultError('repair payload failed checksum', 422)
    this.chunks.set(ref.id, { ref, data: Buffer.from(data), objectId, version, storedAt: Date.now() })
    this.latentCorruptions.delete(ref.id)
  }

  deleteManifest(objectId: string) {
    const m = this.manifests.get(objectId)
    if (!m) return
    this.manifests.delete(objectId)
    for (const ref of m.chunks) {
      this.chunks.delete(ref.id)
      this.latentCorruptions.delete(ref.id)
    }
    this.dirty(m.partition)
  }

  manifestsInPartition(partition: number, filter?: (m: Manifest) => boolean): Manifest[] {
    const out: Manifest[] = []
    for (const m of this.manifests.values()) {
      if (m.partition === partition && (!filter || filter(m))) out.push(m)
    }
    return out
  }

  merkle(partition: number, n: number, bucketN: (bucket: string) => number): MerkleSummary {
    const key = `${partition}:${n}`
    const cached = this.merkleCache.get(key)
    if (cached) return cached
    const leaves = this.manifestsInPartition(partition, (m) => bucketN(m.bucket) === n).map((m) => ({
      id: m.id,
      digest: `${versionToString(m.version)}:${m.deleted ? 'D' : m.sha256}`,
    }))
    const summary = buildMerkle(leaves)
    this.merkleCache.set(key, summary)
    return summary
  }

  entriesInBuckets(
    partition: number,
    n: number,
    buckets: number[],
    bucketN: (bucket: string) => number,
  ): { id: string; version: Version }[] {
    const set = new Set(buckets)
    return this.manifestsInPartition(
      partition,
      (m) => bucketN(m.bucket) === n && set.has(merkleBucket(m.id)),
    ).map((m) => ({ id: m.id, version: m.version }))
  }

  corruptRandomChunk(objectId?: string): string | null {
    const candidates = [...this.chunks.values()].filter(
      (c) => (!objectId || c.objectId === objectId) && !this.latentCorruptions.has(c.ref.id),
    )
    if (candidates.length === 0) return null
    const victim = candidates[Math.floor(Math.random() * candidates.length)]
    const pos = Math.floor(Math.random() * victim.data.length)
    victim.data[pos] = victim.data[pos] ^ 0xff
    this.latentCorruptions.add(victim.ref.id)
    return victim.ref.id
  }

  nextScrubBatch(size: number): StoredChunk[] {
    if (this.scrubQueue.length === 0) this.scrubQueue = [...this.chunks.keys()]
    const batch: StoredChunk[] = []
    while (batch.length < size && this.scrubQueue.length > 0) {
      const id = this.scrubQueue.shift()!
      const chunk = this.chunks.get(id)
      if (chunk) batch.push(chunk)
    }
    return batch
  }

  nextManifestBatch(size: number): Manifest[] {
    if (this.manifestQueue.length === 0) this.manifestQueue = [...this.manifests.keys()]
    const batch: Manifest[] = []
    while (batch.length < size && this.manifestQueue.length > 0) {
      const id = this.manifestQueue.shift()!
      const m = this.manifests.get(id)
      if (m) batch.push(m)
    }
    return batch
  }

  wipe() {
    this.manifests.clear()
    this.chunks.clear()
    this.hints.clear()
    this.latentCorruptions.clear()
    this.merkleCache.clear()
    this.scrubQueue = []
    this.manifestQueue = []
  }

  bytes(): number {
    let total = 0
    for (const c of this.chunks.values()) total += c.data.length
    return total
  }

  hintBytes(): number {
    let total = 0
    for (const h of this.hints.values()) for (const c of h.chunks) total += c.data.length
    return total
  }

  private dirty(partition: number) {
    for (const key of this.merkleCache.keys()) {
      if (key.startsWith(`${partition}:`)) this.merkleCache.delete(key)
    }
  }
}
