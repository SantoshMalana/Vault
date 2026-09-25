import { hash32, sha256 } from './util'

export const PARTITION_COUNT = 64
export const MERKLE_FANOUT = 16

export function partitionOf(objectId: string): number {
  return hash32(objectId) % PARTITION_COUNT
}

export function initialRing(nodeIds: string[]): string[] {
  return Array.from({ length: PARTITION_COUNT }, (_, i) => nodeIds[i % nodeIds.length])
}

/** Walk the ring clockwise from a partition and collect distinct owners. */
export function ringWalk(ring: string[], partition: number): string[] {
  const out: string[] = []
  for (let i = 0; i < ring.length; i++) {
    const owner = ring[(partition + i) % ring.length]
    if (!out.includes(owner)) out.push(owner)
  }
  return out
}

export function preferenceList(ring: string[], partition: number, n: number): string[] {
  return ringWalk(ring, partition).slice(0, n)
}

function ownerCounts(ring: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const owner of ring) counts.set(owner, (counts.get(owner) ?? 0) + 1)
  return counts
}

function circularDistance(a: number, b: number, size: number) {
  const d = Math.abs(a - b)
  return Math.min(d, size - d)
}

/**
 * A joining node steals partitions one at a time from whichever node owns the
 * most, choosing partitions spread far apart. Only its fair share moves.
 */
export function claimPartitions(ring: string[], newNode: string): string[] {
  const next = [...ring]
  const counts = ownerCounts(next)
  const target = Math.floor(next.length / (counts.size + 1))
  const mine: number[] = []

  for (let k = 0; k < target; k++) {
    let donor = ''
    let donorCount = -1
    for (const [node, count] of counts) {
      if (node !== newNode && count > donorCount) {
        donor = node
        donorCount = count
      }
    }
    let best = -1
    let bestScore = -Infinity
    next.forEach((owner, idx) => {
      if (owner !== donor) return
      const score =
        mine.length === 0
          ? -idx
          : Math.min(...mine.map((m) => circularDistance(m, idx, next.length)))
      if (score > bestScore) {
        bestScore = score
        best = idx
      }
    })
    if (best === -1) break
    next[best] = newNode
    mine.push(best)
    counts.set(donor, (counts.get(donor) ?? 1) - 1)
    counts.set(newNode, (counts.get(newNode) ?? 0) + 1)
  }
  return next
}

/** Hand a leaving node's partitions to the least-loaded remaining nodes. */
export function releasePartitions(ring: string[], leaving: string, remaining: string[]): string[] {
  const next = [...ring]
  const counts = new Map(remaining.map((id) => [id, 0]))
  for (const owner of next) if (counts.has(owner)) counts.set(owner, (counts.get(owner) ?? 0) + 1)

  next.forEach((owner, idx) => {
    if (owner !== leaving) return
    const prev = next[(idx - 1 + next.length) % next.length]
    const after = next[(idx + 1) % next.length]
    const candidates = [...counts.entries()].sort((a, b) => a[1] - b[1])
    const choice =
      candidates.find(([id]) => id !== prev && id !== after) ?? candidates[0]
    if (!choice) return
    next[idx] = choice[0]
    counts.set(choice[0], choice[1] + 1)
  })
  return next
}

export function movingPartitions(prev: string[], next: string[], n: number): number[] {
  const moving: number[] = []
  for (let p = 0; p < next.length; p++) {
    const a = preferenceList(prev, p, n)
    const b = preferenceList(next, p, n)
    if (a.length !== b.length || a.some((id) => !b.includes(id))) moving.push(p)
  }
  return moving
}

export interface MerkleSummary {
  root: string
  buckets: string[]
  leaves: number
}

export interface MerkleLeaf {
  id: string
  digest: string
}

/** Two-level Merkle tree: 16 bucket hashes under one root. */
export function buildMerkle(leaves: MerkleLeaf[]): MerkleSummary {
  const buckets: MerkleLeaf[][] = Array.from({ length: MERKLE_FANOUT }, () => [])
  for (const leaf of leaves) buckets[merkleBucket(leaf.id)].push(leaf)
  const bucketHashes = buckets.map((items) =>
    items.length === 0
      ? ''
      : sha256(
          items
            .sort((a, b) => (a.id < b.id ? -1 : 1))
            .map((l) => `${l.id}=${l.digest}`)
            .join('\n'),
        ),
  )
  return { root: sha256(bucketHashes.join('|')), buckets: bucketHashes, leaves: leaves.length }
}

export function merkleBucket(id: string): number {
  return hash32(`m:${id}`) % MERKLE_FANOUT
}

export function diffMerkle(a: MerkleSummary, b: MerkleSummary): number[] {
  const out: number[] = []
  for (let i = 0; i < MERKLE_FANOUT; i++) if (a.buckets[i] !== b.buckets[i]) out.push(i)
  return out
}
