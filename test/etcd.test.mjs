import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EtcdMetadata } from '../services/metadata.mjs'
import { startStorage } from '../services/storage.mjs'
import { startGateway } from '../services/gateway.mjs'

async function freePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise((r) => child.once('exit', r))
  child.kill('SIGKILL')
  await done
}

test(
  'real etcd quorum: atomic CAS, leader loss, majority loss and durable restart',
  { skip: !process.env.ETCD_BINARY, timeout: 120000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vault-etcd-'))
    const members = await Promise.all(
      [1, 2, 3].map(async (id) => ({
        name: `meta${id}`,
        client: `http://127.0.0.1:${await freePort()}`,
        peer: `http://127.0.0.1:${await freePort()}`,
      })),
    )
    const cluster = members.map((m) => `${m.name}=${m.peer}`).join(',')
    const children = []
    const services = []
    let logs = ''
    function start(member) {
      const child = spawn(
        process.env.ETCD_BINARY,
        [
          '--name',
          member.name,
          '--data-dir',
          join(directory, member.name),
          '--listen-client-urls',
          member.client,
          '--advertise-client-urls',
          member.client,
          '--listen-peer-urls',
          member.peer,
          '--initial-advertise-peer-urls',
          member.peer,
          '--initial-cluster',
          cluster,
          '--initial-cluster-token',
          'vault-test',
          '--initial-cluster-state',
          'new',
          '--log-level',
          'error',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
      )
      child.stderr.on('data', (data) => {
        logs = (logs + data.toString()).slice(-6000)
      })
      children.push(child)
      return child
    }
    const store = new EtcdMetadata(members.map((m) => m.client)),
      other = new EtcdMetadata(members.map((m) => m.client).reverse())
    async function ready() {
      const end = Date.now() + 20000
      while (Date.now() < end) {
        try {
          await store.get('/vault/test/ready')
          return
        } catch {
          await new Promise((r) => setTimeout(r, 100))
        }
      }
      throw new Error(`etcd failed to become ready: ${logs}`)
    }
    try {
      const live = members.map(start)
      await ready()
      assert(
        await store.txn(
          [{ key: '/vault/test/object', revision: 0 }],
          [
            { key: '/vault/test/object', value: { version: 1 } },
            { key: '/vault/test/request', value: 'committed' },
          ],
        ),
      )
      const current = await other.get('/vault/test/object')
      const writers = await Promise.all(
        [store, other].map((s, i) =>
          s.txn(
            [{ key: '/vault/test/object', revision: current.revision }],
            [{ key: '/vault/test/object', value: { version: i + 2 } }],
          ),
        ),
      )
      assert.equal(writers.filter(Boolean).length, 1)
      const committed = await store.get('/vault/test/object')
      const token = 'etcd-integration-admin-credential'
      const nodeToken = 'etcd-integration-node-credential'
      const nodes = []
      for (let i = 1; i <= 3; i++) {
        const node = await startStorage({
          id: `n${i}`,
          token: nodeToken,
          port: 0,
          directory: join(directory, `n${i}`),
        })
        services.push(node)
        nodes.push({ id: `n${i}`, url: `http://127.0.0.1:${node.port}`, domain: `host-${i}` })
      }
      const gateways = []
      for (let i = 1; i <= 2; i++) {
        const gateway = await startGateway({
          port: 0,
          directory: join(directory, `gateway${i}`),
          nodes,
          adminToken: token,
          nodeToken,
          etcdEndpoints: members.map((m) => m.client),
          repairMs: 60000,
        })
        services.push(gateway)
        gateways.push(`http://127.0.0.1:${gateway.port}`)
      }
      const api = (index, init = {}) =>
        fetch(gateways[index] + '/v1/objects/default/consensus.txt', {
          ...init,
          headers: { authorization: `Bearer ${token}`, ...init.headers },
        })
      const uploads = await Promise.all(
        gateways.map((_, i) =>
          api(i, {
            method: 'PUT',
            body: `writer-${i}`,
            headers: { 'if-none-match': '*', 'idempotency-key': `gateway-write-${i}` },
          }),
        ),
      )
      assert.equal(uploads.filter((r) => r.status === 201).length, 1)
      assert(uploads.every((r) => [201, 409, 412].includes(r.status)))
      const winner = uploads.findIndex((r) => r.status === 201)
      await Promise.all(uploads.map((r) => r.arrayBuffer()))
      assert.equal(await (await api(1 - winner)).text(), `writer-${winner}`)
      const replay = await api(1 - winner, {
        method: 'PUT',
        body: `writer-${winner}`,
        headers: { 'if-none-match': '*', 'idempotency-key': `gateway-write-${winner}` },
      })
      assert.equal(replay.status, 200, await replay.clone().text())
      await replay.arrayBuffer()
      const statuses = await Promise.all(
        members.map(async (m) => {
          const res = await fetch(`${m.client}/v3/maintenance/status`, {
            method: 'POST',
            body: '{}',
            headers: { 'content-type': 'application/json' },
          })
          return res.json()
        }),
      )
      const leader = statuses.findIndex((s) => s.header.member_id === s.leader)
      assert(leader >= 0)
      await terminate(live[leader])
      await ready()
      assert.deepEqual((await other.get('/vault/test/object')).value, committed.value)
      assert.equal(await (await api(0)).text(), `writer-${winner}`)
      const second = (leader + 1) % 3
      await terminate(live[second])
      await assert.rejects(
        () =>
          store.txn(
            [{ key: '/vault/test/unavailable', revision: 0 }],
            [{ key: '/vault/test/unavailable', value: 'must not commit' }],
          ),
        (e) => e.status === 503,
      )
      const unavailableRead = await api(1)
      assert.equal(unavailableRead.status, 503)
      await unavailableRead.arrayBuffer()
      live[leader] = start(members[leader])
      live[second] = start(members[second])
      await ready()
      // Timed-out writes can commit later; use the request/transaction record to resolve outcomes.
      assert.deepEqual((await store.get('/vault/test/object')).value, committed.value)
      for (const child of live) await terminate(child)
      members.forEach(start)
      await ready()
      assert.deepEqual((await store.get('/vault/test/object')).value, committed.value)
      assert.equal((await store.get('/vault/test/request')).value, 'committed')
      assert.equal(await (await api(1)).text(), `writer-${winner}`)
    } finally {
      for (const service of services.reverse()) await service.close()
      for (const child of children) await terminate(child)
      assert(directory.startsWith(join(tmpdir(), 'vault-etcd-')))
      await rm(directory, { recursive: true, force: true })
    }
  },
)
