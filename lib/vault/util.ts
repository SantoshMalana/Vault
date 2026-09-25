import { createHash } from 'node:crypto'
import type { Version } from './types'

export class VaultError extends Error {
  constructor(
    message: string,
    public status = 500,
    public details?: unknown,
  ) {
    super(message)
  }
}

export function sha256(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hash32(input: string): number {
  return createHash('md5').update(input).digest().readUInt32BE(0)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1))
}

export function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export function pick<T>(items: T[]): T | undefined {
  return items[Math.floor(Math.random() * items.length)]
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function compareVersions(a: Version, b: Version): number {
  if (a.t !== b.t) return a.t - b.t
  if (a.c !== b.c) return a.c - b.c
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0
}

export function versionToString(v: Version): string {
  return `${v.t}.${v.c}.${v.n}`
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Hybrid logical clock: physical time (plus injected skew) combined with a
 * logical counter so causally-related writes always get increasing versions.
 */
export class HybridClock {
  private t = 0
  private c = 0

  constructor(
    private readonly nodeId: string,
    private readonly skewMs: () => number,
  ) {}

  now(): Version {
    const physical = Date.now() + this.skewMs()
    if (physical > this.t) {
      this.t = physical
      this.c = 0
    } else {
      this.c += 1
    }
    return { t: this.t, c: this.c, n: this.nodeId }
  }

  observe(remote: Version) {
    const physical = Date.now() + this.skewMs()
    const max = Math.max(physical, this.t, remote.t)
    if (max === this.t && max === remote.t) this.c = Math.max(this.c, remote.c) + 1
    else if (max === this.t) this.c += 1
    else if (max === remote.t) this.c = remote.c + 1
    else this.c = 0
    this.t = max
  }
}
