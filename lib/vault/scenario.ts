import { randomBytes } from 'node:crypto'
import type { Cluster } from './cluster'
import { getObject, putObject } from './coordinator'
import type { ScenarioResult, ScenarioState, ScenarioStep, Version } from './types'
import { compareVersions, errorMessage, pick, randInt, sha256, sleep, VaultError } from './util'

export interface ScenarioOptions {
  keys: number
  writeRate: number
  holdMs: number
  corruptChunks: number
  convergeTimeoutMs: number
}

export const DEFAULT_SCENARIO: ScenarioOptions = {
  keys: 60,
  writeRate: 25,
  holdMs: 4000,
  corruptChunks: 6,
  convergeTimeoutMs: 90_000,
}

export interface ScenarioRunner {
  readonly state: ScenarioState
  start(opts?: Partial<ScenarioOptions>): void
  cancel(): void
}

const BUCKET = 'torture'

const STEP_DEFS: { id: string; label: string }[] = [
  { id: 'prepare', label: 'Heal cluster and create "torture" bucket (N=3, W=2, R=2, sloppy)' },
  { id: 'seed', label: 'Seed objects and record every acknowledged write' },
  { id: 'load', label: 'Start continuous overwrite load' },
  { id: 'join', label: 'Add a storage node (triggers rebalance)' },
  { id: 'crash', label: 'Crash a storage node mid-rebalance' },
  { id: 'partition', label: 'Partition the network (minority: 1 storage + 1 metadata)' },
  { id: 'corrupt', label: 'Flip bytes in chunks on a live replica' },
  { id: 'hold', label: 'Keep writing under combined failure' },
  { id: 'heal', label: 'Stop load, heal partition, restart crashed node' },
  { id: 'converge', label: 'Wait for hints, anti-entropy, scrub and rebalance to converge' },
  { id: 'verify', label: 'Read back every acknowledged key and compare checksums' },
]

interface Acked {
  version: Version
  sha256: string
}

export function createScenario(cluster: Cluster): ScenarioRunner {
  const state: ScenarioState = {
    running: false,
    startedAt: null,
    finishedAt: null,
    steps: STEP_DEFS.map((s) => ({ ...s, status: 'pending' })),
    result: null,
    error: null,
  }
  let token = 0

  const step = (id: string): ScenarioStep => state.steps.find((s) => s.id === id)!

  async function run(opts: ScenarioOptions, myToken: number) {
    const alive = () => {
      if (myToken !== token) throw new VaultError('scenario cancelled', 499)
    }
    const acked = new Map<string, Acked>()
    let writerOn = false
    let writerLoop: Promise<void> = Promise.resolve()
    let unavailable = 0
    const baseline = { ...cluster.counters }

    const write = async (key: string) => {
      const data = randomBytes(randInt(1024, 40 * 1024))
      try {
        const res = await putObject(cluster, { bucket: BUCKET, key, data, contentType: 'application/octet-stream' })
        const [t, c, ...rest] = res.version.split('.')
        const version = { t: Number(t), c: Number(c), n: rest.join('.') }
        const prev = acked.get(key)
        if (!prev || compareVersions(version, prev.version) > 0) acked.set(key, { version, sha256: sha256(data) })
      } catch {
        unavailable += 1
      }
    }

    const phase = async (id: string, fn: () => Promise<string | void>) => {
      alive()
      const s = step(id)
      s.status = 'running'
      cluster.emit('info', 'scenario', `torture test: ${s.label}`)
      try {
        const detail = await fn()
        s.status = 'done'
        if (detail) s.detail = detail
      } catch (err) {
        s.status = 'failed'
        s.detail = errorMessage(err)
        throw err
      }
    }

    try {
      await phase('prepare', async () => {
        cluster.heal()
        for (const node of cluster.nodes.values()) if (!node.up && cluster.config.members[node.id]) cluster.revive(node.id)
        for (const r of cluster.raft.values()) if (!r.up) cluster.revive(r.id)
        for (const node of cluster.nodes.values()) {
          if (node.slowMs) cluster.setSlow(node.id, 0)
        }
        const deadline = Date.now() + 5000
        while (!cluster.leader() && Date.now() < deadline) await sleep(100)
        if (!cluster.config.buckets[BUCKET]) {
          await cluster.setBucket({ name: BUCKET, n: 3, w: 2, r: 2, sloppy: true })
        }
        return `${cluster.activeMembers().length} active nodes, leader ${cluster.leader()?.id ?? 'none'}`
      })

      await phase('seed', async () => {
        const keys = Array.from({ length: opts.keys }, (_, i) => `t-${String(i).padStart(4, '0')}`)
        for (let i = 0; i < keys.length; i += 8) {
          alive()
          await Promise.all(keys.slice(i, i + 8).map((k) => write(k)))
        }
        return `${acked.size}/${opts.keys} keys acknowledged`
      })

      await phase('load', async () => {
        writerOn = true
        const interval = Math.max(5, Math.floor(1000 / opts.writeRate))
        writerLoop = (async () => {
          while (writerOn && myToken === token) {
            void write(`t-${String(randInt(0, opts.keys - 1)).padStart(4, '0')}`)
            await sleep(interval)
          }
        })()
        return `${opts.writeRate} overwrites/s`
      })

      let joined = ''
      await phase('join', async () => {
        joined = await cluster.addNode()
        return `${joined} joined at epoch ${cluster.config.epoch}`
      })

      let crashed = ''
      await phase('crash', async () => {
        const deadline = Date.now() + 3000
        while (Date.now() < deadline && cluster.rebalance.done.size === 0) await sleep(50)
        const candidates = cluster.activeMembers().filter((id) => id !== joined && cluster.nodes.get(id)?.up)
        crashed = pick(candidates) ?? ''
        if (!crashed) throw new VaultError('no node available to crash', 409)
        cluster.kill(crashed)
        return `killed ${crashed} with ${cluster.rebalance.done.size} vnodes already moved`
      })

      await phase('partition', async () => {
        const others = cluster.activeMembers().filter((id) => id !== crashed && cluster.nodes.get(id)?.up)
        const isolated = pick(others.filter((id) => id !== joined)) ?? pick(others)
        if (!isolated) throw new VaultError('not enough nodes to partition', 409)
        const metas = [...cluster.raft.keys()]
        const minorityMeta = metas[metas.length - 1]
        cluster.partition([[isolated, minorityMeta], others.filter((id) => id !== isolated)])
        return `isolated {${isolated}, ${minorityMeta}}`
      })

      await phase('corrupt', async () => {
        const victims = [...cluster.nodes.values()].filter((n) => n.up && n.chunks.size > 0)
        const victim = pick(victims)
        if (!victim) return 'no chunks to corrupt'
        const hit = cluster.corrupt(victim.id, Math.min(opts.corruptChunks, victim.chunks.size))
        return `${hit.length} chunks corrupted on ${victim.id}`
      })

      await phase('hold', async () => {
        const end = Date.now() + opts.holdMs
        while (Date.now() < end) {
          alive()
          await sleep(100)
        }
        return `${acked.size} keys tracked, ${unavailable} writes rejected so far`
      })

      await phase('heal', async () => {
        writerOn = false
        await writerLoop
        await sleep(300)
        cluster.heal()
        if (crashed) cluster.revive(crashed)
        return `restarted ${crashed}`
      })

      const convergeStart = Date.now()
      let convergeMs: number | null = null
      await phase('converge', async () => {
        const deadline = convergeStart + opts.convergeTimeoutMs
        while (Date.now() < deadline) {
          alive()
          if (cluster.isConverged() && cluster.latentCorruptionCount() === 0) {
            convergeMs = Date.now() - convergeStart
            return `converged in ${(convergeMs / 1000).toFixed(1)}s`
          }
          await sleep(250)
        }
        return `did not fully converge within ${opts.convergeTimeoutMs / 1000}s; verifying anyway`
      })

      let verified = 0
      let lost = 0
      let corruptServed = 0
      await phase('verify', async () => {
        const entries = [...acked.entries()]
        for (let i = 0; i < entries.length; i += 8) {
          alive()
          await Promise.all(
            entries.slice(i, i + 8).map(async ([key, expect]) => {
              try {
                const res = await getObject(cluster, BUCKET, key, { consistency: 'quorum' })
                const cmp = compareVersions(res.manifest.version, expect.version)
                if (cmp < 0) lost += 1
                else if (cmp === 0 && sha256(res.data) !== expect.sha256) corruptServed += 1
                else verified += 1
              } catch {
                lost += 1
              }
            }),
          )
        }
        return `${verified}/${entries.length} verified, ${lost} lost, ${corruptServed} corrupt`
      })

      const result: ScenarioResult = {
        passed: lost === 0 && corruptServed === 0,
        ackedWrites: acked.size,
        verified,
        lost,
        corruptServed,
        unavailable,
        convergeMs,
        repairs: {
          readRepair: cluster.counters.readRepairs - baseline.readRepairs,
          antiEntropy: cluster.counters.antiEntropyRepairs - baseline.antiEntropyRepairs,
          scrub: cluster.counters.scrubRepairs - baseline.scrubRepairs,
          hintsDelivered: cluster.counters.hintsDelivered - baseline.hintsDelivered,
        },
      }
      state.result = result
      cluster.emit(
        result.passed ? 'success' : 'error',
        'scenario',
        result.passed
          ? `torture test PASSED: ${verified} acknowledged keys intact, zero loss, zero corrupt reads`
          : `torture test FAILED: ${lost} lost, ${corruptServed} corrupt reads`,
      )
    } catch (err) {
      writerOn = false
      if (myToken === token) {
        state.error = errorMessage(err)
        cluster.emit('error', 'scenario', `torture test aborted: ${state.error}`)
      }
    } finally {
      if (myToken === token) {
        state.running = false
        state.finishedAt = Date.now()
      }
    }
  }

  return {
    state,
    start(partial) {
      if (state.running) throw new VaultError('torture test already running', 409)
      const opts = { ...DEFAULT_SCENARIO, ...partial }
      token += 1
      state.running = true
      state.startedAt = Date.now()
      state.finishedAt = null
      state.result = null
      state.error = null
      state.steps = STEP_DEFS.map((s) => ({ ...s, status: 'pending' }))
      void run(opts, token)
    },
    cancel() {
      if (!state.running) return
      token += 1
      state.running = false
      state.finishedAt = Date.now()
      state.error = 'cancelled'
      for (const s of state.steps) if (s.status === 'running') s.status = 'failed'
    },
  }
}
