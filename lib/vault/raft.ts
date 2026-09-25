import type { Network } from './network'
import { claimPartitions, releasePartitions } from './ring'
import type { BucketPolicy, ClusterConfig, RaftRole } from './types'
import { randInt, VaultError } from './util'

export type RaftCommand =
  | { type: 'bootstrap'; config: ClusterConfig }
  | { type: 'add-node'; nodeId: string }
  | { type: 'decommission-node'; nodeId: string }
  | { type: 'finish-rebalance'; epoch: number }
  | { type: 'set-bucket'; policy: BucketPolicy }
  | { type: 'delete-bucket'; name: string }

interface LogEntry {
  term: number
  cmd: RaftCommand | null
}

type Message =
  | { type: 'vote'; term: number; from: string; lastLogIndex: number; lastLogTerm: number }
  | { type: 'vote-reply'; term: number; from: string; granted: boolean }
  | {
      type: 'append'
      term: number
      from: string
      prevLogIndex: number
      prevLogTerm: number
      entries: LogEntry[]
      leaderCommit: number
    }
  | { type: 'append-reply'; term: number; from: string; success: boolean; matchIndex: number }

const HEARTBEAT_MS = 120
const CHECK_QUORUM_MS = 1200

export function describeCommand(cmd: RaftCommand | null): string {
  if (!cmd) return 'noop'
  switch (cmd.type) {
    case 'bootstrap':
      return `bootstrap ${Object.keys(cmd.config.members).length} nodes`
    case 'add-node':
      return `add-node ${cmd.nodeId}`
    case 'decommission-node':
      return `decommission ${cmd.nodeId}`
    case 'finish-rebalance':
      return `finish-rebalance @${cmd.epoch}`
    case 'set-bucket':
      return `set-bucket ${cmd.policy.name} N${cmd.policy.n}/W${cmd.policy.w}/R${cmd.policy.r}${cmd.policy.sloppy ? ' sloppy' : ' strict'}`
    case 'delete-bucket':
      return `delete-bucket ${cmd.name}`
  }
}

/** Deterministic state machine every metadata replica applies in log order. */
export function applyCommand(cfg: ClusterConfig, cmd: RaftCommand | null): ClusterConfig {
  if (!cmd) return cfg
  const next: ClusterConfig = structuredClone(cfg)
  switch (cmd.type) {
    case 'bootstrap':
      return structuredClone(cmd.config)
    case 'add-node': {
      if (next.members[cmd.nodeId]) return cfg
      next.epoch += 1
      next.members[cmd.nodeId] = { id: cmd.nodeId, state: 'active', joinedEpoch: next.epoch }
      next.prevRing = next.prevRing ?? next.ring
      next.ring = claimPartitions(next.ring, cmd.nodeId)
      return next
    }
    case 'decommission-node': {
      const member = next.members[cmd.nodeId]
      if (!member || member.state === 'leaving') return cfg
      const remaining = Object.values(next.members)
        .filter((m) => m.state === 'active' && m.id !== cmd.nodeId)
        .map((m) => m.id)
      if (remaining.length === 0) return cfg
      next.epoch += 1
      member.state = 'leaving'
      next.prevRing = next.prevRing ?? next.ring
      next.ring = releasePartitions(next.ring, cmd.nodeId, remaining)
      return next
    }
    case 'finish-rebalance': {
      if (cmd.epoch !== next.epoch || !next.prevRing) return cfg
      next.prevRing = null
      for (const m of Object.values(next.members)) {
        if (m.state === 'leaving') delete next.members[m.id]
      }
      next.epoch += 1
      return next
    }
    case 'set-bucket':
      next.buckets[cmd.policy.name] = { ...cmd.policy }
      next.epoch += 1
      return next
    case 'delete-bucket':
      delete next.buckets[cmd.name]
      next.epoch += 1
      return next
  }
}

export class RaftNode {
  up = true
  role: RaftRole = 'follower'
  term = 1
  votedFor: string | null = null
  leaderId: string | null = null
  log: LogEntry[] = [{ term: 0, cmd: null }]
  commitIndex = 0
  lastApplied = 0
  config: ClusterConfig
  private electionDeadline = 0
  private lastBroadcast = 0
  private votes = new Set<string>()
  private nextIndex = new Map<string, number>()
  private matchIndex = new Map<string, number>()
  private lastContact = new Map<string, number>()
  private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(
    readonly id: string,
    private readonly peerIds: string[],
    private readonly net: Network,
    private readonly peers: () => Map<string, RaftNode>,
    bootstrap: ClusterConfig,
    private readonly onEvent: (level: 'info' | 'warn' | 'success', msg: string) => void,
  ) {
    this.log.push({ term: 1, cmd: { type: 'bootstrap', config: bootstrap } })
    this.commitIndex = 1
    this.config = bootstrap
    this.lastApplied = 1
    this.resetElection(Date.now())
  }

  private get majority() {
    return Math.floor((this.peerIds.length + 1) / 2) + 1
  }

  private lastLogIndex() {
    return this.log.length - 1
  }

  private resetElection(now: number) {
    this.electionDeadline = now + randInt(500, 1000)
  }

  crash() {
    this.up = false
    this.becomeFollower(this.term, null)
  }

  restart() {
    this.up = true
    this.role = 'follower'
    this.leaderId = null
    this.resetElection(Date.now())
  }

  tick(now: number) {
    if (!this.up) return
    if (this.role === 'leader') {
      if (now - this.lastBroadcast >= HEARTBEAT_MS) this.broadcastAppend(now)
      const contacted = this.peerIds.filter((p) => now - (this.lastContact.get(p) ?? 0) < CHECK_QUORUM_MS).length
      if (contacted + 1 < this.majority) {
        this.onEvent('warn', `${this.id} lost contact with a majority and stepped down (term ${this.term})`)
        this.becomeFollower(this.term, null)
      }
    } else if (now >= this.electionDeadline) {
      this.startElection(now)
    }
  }

  private startElection(now: number) {
    this.role = 'candidate'
    this.term += 1
    this.votedFor = this.id
    this.leaderId = null
    this.votes = new Set([this.id])
    this.resetElection(now)
    const lastLogIndex = this.lastLogIndex()
    const lastLogTerm = this.log[lastLogIndex].term
    for (const peer of this.peerIds) {
      this.sendTo(peer, { type: 'vote', term: this.term, from: this.id, lastLogIndex, lastLogTerm })
    }
  }

  private becomeFollower(term: number, leader: string | null) {
    const wasLeader = this.role === 'leader'
    if (term > this.term) {
      this.term = term
      this.votedFor = null
    }
    this.role = 'follower'
    this.leaderId = leader
    if (wasLeader) {
      for (const [idx, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new VaultError('metadata leader changed before commit; outcome unknown, retry', 503))
        this.pending.delete(idx)
      }
    }
  }

  private becomeLeader(now: number) {
    this.role = 'leader'
    this.leaderId = this.id
    for (const peer of this.peerIds) {
      this.nextIndex.set(peer, this.log.length)
      this.matchIndex.set(peer, 0)
      this.lastContact.set(peer, now)
    }
    this.onEvent('success', `${this.id} elected metadata leader for term ${this.term}`)
    this.log.push({ term: this.term, cmd: null })
    this.broadcastAppend(now)
  }

  private sendTo(peer: string, msg: Message) {
    this.net.send(this.id, peer, () => this.peers().get(peer)?.receive(msg))
  }

  private broadcastAppend(now: number) {
    this.lastBroadcast = now
    for (const peer of this.peerIds) {
      const next = this.nextIndex.get(peer) ?? this.log.length
      const prevLogIndex = next - 1
      this.sendTo(peer, {
        type: 'append',
        term: this.term,
        from: this.id,
        prevLogIndex,
        prevLogTerm: this.log[prevLogIndex]?.term ?? 0,
        entries: this.log.slice(next, next + 50),
        leaderCommit: this.commitIndex,
      })
    }
  }

  receive(msg: Message) {
    if (!this.up) return
    const now = Date.now()
    if (msg.term > this.term) this.becomeFollower(msg.term, msg.type === 'append' ? msg.from : null)

    switch (msg.type) {
      case 'vote': {
        const myLastIndex = this.lastLogIndex()
        const myLastTerm = this.log[myLastIndex].term
        const upToDate =
          msg.lastLogTerm > myLastTerm || (msg.lastLogTerm === myLastTerm && msg.lastLogIndex >= myLastIndex)
        const granted =
          msg.term === this.term && (this.votedFor === null || this.votedFor === msg.from) && upToDate
        if (granted) {
          this.votedFor = msg.from
          this.resetElection(now)
        }
        this.sendTo(msg.from, { type: 'vote-reply', term: this.term, from: this.id, granted })
        return
      }
      case 'vote-reply': {
        if (this.role !== 'candidate' || msg.term !== this.term || !msg.granted) return
        this.votes.add(msg.from)
        if (this.votes.size >= this.majority) this.becomeLeader(now)
        return
      }
      case 'append': {
        if (msg.term < this.term) {
          this.sendTo(msg.from, { type: 'append-reply', term: this.term, from: this.id, success: false, matchIndex: 0 })
          return
        }
        this.role = 'follower'
        this.leaderId = msg.from
        this.resetElection(now)
        const prevOk =
          msg.prevLogIndex < this.log.length && this.log[msg.prevLogIndex].term === msg.prevLogTerm
        if (!prevOk) {
          this.sendTo(msg.from, {
            type: 'append-reply',
            term: this.term,
            from: this.id,
            success: false,
            matchIndex: Math.min(this.lastLogIndex(), Math.max(0, msg.prevLogIndex - 1)),
          })
          return
        }
        msg.entries.forEach((entry, i) => {
          const idx = msg.prevLogIndex + 1 + i
          if (idx < this.log.length && this.log[idx].term !== entry.term) this.log.length = idx
          if (idx >= this.log.length) this.log.push(entry)
        })
        const lastNew = msg.prevLogIndex + msg.entries.length
        if (msg.leaderCommit > this.commitIndex) {
          this.commitIndex = Math.min(msg.leaderCommit, lastNew)
          this.applyCommitted()
        }
        this.sendTo(msg.from, { type: 'append-reply', term: this.term, from: this.id, success: true, matchIndex: lastNew })
        return
      }
      case 'append-reply': {
        if (this.role !== 'leader' || msg.term !== this.term) return
        this.lastContact.set(msg.from, now)
        if (msg.success) {
          this.matchIndex.set(msg.from, Math.max(this.matchIndex.get(msg.from) ?? 0, msg.matchIndex))
          this.nextIndex.set(msg.from, (this.matchIndex.get(msg.from) ?? 0) + 1)
          this.advanceCommit()
        } else {
          this.nextIndex.set(msg.from, Math.max(1, msg.matchIndex + 1))
        }
        return
      }
    }
  }

  private advanceCommit() {
    for (let n = this.lastLogIndex(); n > this.commitIndex; n--) {
      if (this.log[n].term !== this.term) continue
      const replicated = 1 + this.peerIds.filter((p) => (this.matchIndex.get(p) ?? 0) >= n).length
      if (replicated >= this.majority) {
        this.commitIndex = n
        this.applyCommitted()
        break
      }
    }
  }

  private applyCommitted() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied += 1
      this.config = applyCommand(this.config, this.log[this.lastApplied].cmd)
      const p = this.pending.get(this.lastApplied)
      if (p) {
        clearTimeout(p.timer)
        p.resolve()
        this.pending.delete(this.lastApplied)
      }
    }
  }

  propose(cmd: RaftCommand): Promise<void> {
    if (!this.up || this.role !== 'leader') {
      return Promise.reject(new VaultError(`${this.id} is not the metadata leader`, 503))
    }
    this.log.push({ term: this.term, cmd })
    const index = this.lastLogIndex()
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(index)
        reject(new VaultError('metadata commit timed out (no majority reachable)', 503))
      }, 3000)
      this.pending.set(index, { resolve, reject, timer })
    })
    this.broadcastAppend(Date.now())
    return promise
  }
}
