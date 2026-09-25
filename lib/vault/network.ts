import { randInt, sleep, VaultError } from './util'

export interface NetworkHooks {
  isUp(id: string): boolean
  extraLatency(id: string): number
  enter(id: string): void
  leave(id: string): void
  timeoutMs(): number
}

/**
 * Inter-server network. Every message between servers passes through here so
 * partitions, dead processes, latency and overload behave consistently.
 */
export class Network {
  groups: string[][] | null = null

  constructor(private readonly hooks: NetworkHooks) {}

  groupOf(id: string): number | null {
    if (!this.groups) return null
    const idx = this.groups.findIndex((g) => g.includes(id))
    return idx === -1 ? 0 : idx
  }

  canReach(from: string, to: string): boolean {
    if (!this.hooks.isUp(to)) return false
    if (from === to) return true
    if (!this.hooks.isUp(from)) return false
    if (!this.groups) return true
    return this.groupOf(from) === this.groupOf(to)
  }

  private latency(to: string) {
    return randInt(1, 4) + this.hooks.extraLatency(to)
  }

  async rpc<T>(from: string, to: string, handler: () => T | Promise<T>): Promise<T> {
    if (!this.canReach(from, to)) {
      await sleep(this.hooks.timeoutMs())
      throw new VaultError(`${to} unreachable from ${from} (timeout)`, 503)
    }
    this.hooks.enter(to)
    try {
      const latency = this.latency(to)
      await sleep(latency / 2)
      if (!this.canReach(from, to)) throw new VaultError(`${to} dropped request from ${from}`, 503)
      const result = await handler()
      await sleep(latency / 2)
      if (!this.canReach(from, to)) throw new VaultError(`response from ${to} lost`, 503)
      return result
    } finally {
      this.hooks.leave(to)
    }
  }

  /** Fire-and-forget message delivery, used by Raft. */
  send(from: string, to: string, deliver: () => void) {
    const latency = randInt(1, 6)
    setTimeout(() => {
      if (this.canReach(from, to)) deliver()
    }, latency)
  }
}
