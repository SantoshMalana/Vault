import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'

const digest = (x) => createHash('sha256').update(x).digest('hex')
const root = resolve(import.meta.dirname, '..')
const admin = 'integration-admin-token-123456',
  nodeToken = 'integration-node-token-123456'
const children = new Set()
async function launch(file, env) {
  const child = spawn(process.execPath, [join(root, 'services', file)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let errors = '',
    output = ''
  child.stderr.on('data', (d) => {
    errors += d.toString()
  })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${errors}`)), 15000)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Service exited ${code}: ${errors}`))
    })
    child.stdout.on('data', (d) => {
      output += d.toString()
      for (const line of output.split('\n').filter(Boolean)) {
        try {
          const value = JSON.parse(line)
          if (value.status === 'ready') {
            clearTimeout(timer)
            resolve(value)
            return
          }
        } catch {
          /* Wait for a full line. */
        }
      }
    })
  })
  return { child, ...ready, env }
}
async function kill(service) {
  if (service.child.exitCode !== null || service.child.signalCode !== null) return
  const ended = new Promise((resolve) => service.child.once('exit', resolve))
  service.child.kill('SIGKILL')
  await ended
}

test(
  'real processes: durable writes, integrity, quorum, repair, concurrency and restart',
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'vault-integration-'))
    const nodes = [],
      services = []
    let gateway
    try {
      for (let i = 1; i <= 5; i++) {
        const env = {
          NODE_ID: `n${i}`,
          PORT: '0',
          DATA_DIR: join(directory, `n${i}`),
          NODE_TOKEN: nodeToken,
          SCRUB_INTERVAL_MS: '60000',
        }
        const service = await launch('storage.mjs', env)
        services.push(service)
        nodes.push({ id: `n${i}`, url: `http://127.0.0.1:${service.port}`, domain: `host-${i}` })
      }
      const env = {
        PORT: '0',
        DATA_DIR: join(directory, 'gateway'),
        NODE_TOKEN: nodeToken,
        ADMIN_TOKEN: admin,
        STORAGE_NODES: JSON.stringify(nodes),
        REPAIR_INTERVAL_MS: '60000',
        RPC_TIMEOUT_MS: '1800',
        MAX_OBJECT_BYTES: String(32 * 1024 ** 2),
        VAULT_USERS: JSON.stringify([
          { name: 'admin', role: 'admin', token: admin, buckets: ['*'] },
          { name: 'reader', role: 'read', token: 'reader-token-1234567890', buckets: ['default'] },
        ]),
      }
      gateway = await launch('gateway.mjs', env)
      let base = `http://127.0.0.1:${gateway.port}`
      const api = (path, init = {}) =>
        fetch(base + path, { ...init, headers: { authorization: `Bearer ${admin}`, ...init.headers } })
      const put = (key, data, headers = {}) =>
        api(`/v1/objects/default/${key}`, {
          method: 'PUT',
          body: data,
          headers: { 'content-type': 'application/octet-stream', ...headers },
        })
      const get = (key, init = {}) => api(`/v1/objects/default/${key}`, init)
      const body = randomBytes(9 * 1024 ** 2 + 17)
      let written
      await t.test(
        'streams objects larger than the old limit and validates full and range reads',
        async () => {
          const response = await put('large.bin', body, {
            'idempotency-key': 'large-1',
            'x-content-sha256': digest(body),
          })
          assert.equal(response.status, 201, await response.clone().text())
          written = await response.json()
          assert.equal(written.replicas.length, 3)
          const downloaded = await get('large.bin')
          assert.equal(downloaded.status, 200)
          assert.equal(digest(Buffer.from(await downloaded.arrayBuffer())), digest(body))
          const range = await get('large.bin', { headers: { range: 'bytes=100-199' } })
          assert.equal(range.status, 206)
          assert.deepEqual(Buffer.from(await range.arrayBuffer()), body.subarray(100, 200))
          const head = await get('large.bin', { method: 'HEAD' })
          assert.equal(Number(head.headers.get('content-length')), body.length)
        },
      )
      await t.test('auth and read-only permissions are enforced', async () => {
        assert.equal((await fetch(base + '/v1/cluster')).status, 401)
        assert.equal(
          (
            await api('/v1/objects/default/nope', {
              method: 'PUT',
              body: 'x',
              headers: { authorization: 'Bearer reader-token-1234567890' },
            })
          ).status,
          403,
        )
        assert.equal(
          (
            await api('/v1/repair', {
              method: 'POST',
              headers: { authorization: 'Bearer reader-token-1234567890' },
            })
          ).status,
          403,
        )
        assert.equal((await fetch(nodes[0].url + '/health')).status, 401)
      })
      await t.test('idempotency and conditional writes prevent accidental replacement', async () => {
        const replay = await put('large.bin', body, { 'idempotency-key': 'large-1' })
        assert.equal(replay.status, 200)
        assert.equal((await replay.json()).version, written.version)
        assert.equal((await put('large.bin', 'different', { 'idempotency-key': 'large-1' })).status, 409)
        assert.equal((await put('large.bin', 'different', { 'if-none-match': '*' })).status, 412)
        const seed = await (await put('concurrent', 'seed')).json()
        const writes = await Promise.all(
          ['a', 'b'].map((value) => put('concurrent', value, { 'if-match': `"${seed.version}"` })),
        )
        assert.equal(writes.filter((r) => r.status === 201).length, 1)
        assert(writes.some((r) => [409, 412].includes(r.status)))
      })
      await t.test(
        'multipart uploads resume after gateway restart and publish only after completion',
        async () => {
          const content = randomBytes(2 * 1024 ** 2 + 19),
            first = content.subarray(0, 1024 ** 2),
            second = content.subarray(1024 ** 2)
          const created = await api('/v1/uploads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bucket: 'default', key: 'multipart.bin' }),
          })
          assert.equal(created.status, 201)
          const { uploadId } = await created.json()
          const prefix = `/v1/uploads/${uploadId}`
          assert.equal(
            (
              await api(`${prefix}/parts/1`, {
                method: 'PUT',
                body: first,
                headers: { 'x-content-sha256': digest(first), 'idempotency-key': 'part-one' },
              })
            ).status,
            201,
          )
          assert.equal((await get('multipart.bin')).status, 404)
          await kill(gateway)
          gateway = await launch('gateway.mjs', env)
          base = `http://127.0.0.1:${gateway.port}`
          const state = await (await api(prefix)).json()
          assert.equal(state.parts.length, 1)
          assert.equal(state.parts[0].sha256, digest(first))
          assert.equal(
            (
              await api(`${prefix}/parts/2`, {
                method: 'PUT',
                body: second,
                headers: { 'x-content-sha256': digest(second), 'idempotency-key': 'part-two' },
              })
            ).status,
            201,
          )
          const complete = await api(`${prefix}/complete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              parts: [
                { number: 1, sha256: digest(first) },
                { number: 2, sha256: digest(second) },
              ],
            }),
          })
          assert.equal(complete.status, 201, await complete.clone().text())
          assert.equal(digest(Buffer.from(await (await get('multipart.bin')).arrayBuffer())), digest(content))
          assert.equal((await api(`${prefix}/parts/3`, { method: 'PUT', body: first })).status, 409)
        },
      )
      await t.test('corrupt disk bytes never reach the client and background repair fixes them', async () => {
        const holder = written.replicas[0]
        const files = await readdir(join(directory, holder, 'replicas'))
        let replica
        for (const file of files.filter((f) => f.endsWith('.json'))) {
          const receipt = JSON.parse(await readFile(join(directory, holder, 'replicas', file)))
          if (receipt.sha256 === written.sha256) replica = file.slice(0, -5)
        }
        assert(replica)
        const path = join(directory, holder, 'replicas', `${replica}.bin`)
        const damaged = Buffer.from(body)
        damaged[99] ^= 0xff
        await writeFile(path, damaged)
        const response = await get('large.bin')
        assert.equal(response.status, 200)
        assert.equal(digest(Buffer.from(await response.arrayBuffer())), written.sha256)
        const deadline = Date.now() + 15000
        let state
        while (Date.now() < deadline) {
          assert.equal((await api('/v1/repair', { method: 'POST' })).status, 202)
          do {
            await new Promise((r) => setTimeout(r, 100))
            state = await (await api('/v1/cluster')).json()
          } while (state.repair.running && Date.now() < deadline)
          // An open test-reader handle can prevent replacement on Windows. Inspect after the pass.
          if (digest(await readFile(path)) === written.sha256) break
        }
        assert.equal(digest(await readFile(path)), written.sha256, JSON.stringify(state?.events))
      })
      await t.test(
        'failed quorum does not publish a new version; spare nodes rebuild redundancy',
        async () => {
          const targets = written.replicas.slice(0, 2).map((id) => services.find((s) => s.env.NODE_ID === id))
          for (const s of targets) await kill(s)
          const failed = await put('large.bin', 'must-not-commit')
          assert.equal(failed.status, 503)
          assert.equal((await get('large.bin')).status, 503)
          const relaxed = await api('/v1/objects/default/large.bin?consistency=one')
          assert.equal(relaxed.status, 200)
          assert.equal(digest(Buffer.from(await relaxed.arrayBuffer())), written.sha256)
          await api('/v1/repair', { method: 'POST' })
          const deadline = Date.now() + 20000
          let available = false
          while (Date.now() < deadline) {
            const response = await get('large.bin')
            if (response.status === 200) {
              assert.equal(digest(Buffer.from(await response.arrayBuffer())), written.sha256)
              available = true
              break
            }
            await response.arrayBuffer()
            await new Promise((r) => setTimeout(r, 200))
          }
          assert(available, 'repair must restore quorum on spare nodes')
          for (const old of targets) {
            const restored = await launch('storage.mjs', { ...old.env, PORT: String(old.port) })
            services[services.indexOf(old)] = restored
          }
        },
      )
      await t.test(
        'membership changes, bucket policies and verified node draining preserve objects',
        async () => {
          const added = await launch('storage.mjs', {
            NODE_ID: 'n6',
            PORT: '0',
            DATA_DIR: join(directory, 'n6'),
            NODE_TOKEN: nodeToken,
          })
          services.push(added)
          const node = { id: 'n6', url: `http://127.0.0.1:${added.port}`, domain: 'host-6' }
          assert.equal(
            (
              await api('/v1/nodes', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(node),
              })
            ).status,
            201,
          )
          const policy = await api('/v1/buckets', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'archive', n: 4, w: 3, r: 2, sloppy: true }),
          })
          assert.equal(policy.status, 200)
          const archived = await api('/v1/objects/archive/test.txt', {
            method: 'PUT',
            body: 'durable archive',
          })
          assert.equal(archived.status, 201)
          assert.equal((await archived.json()).replicas.length, 4)
          assert.equal(
            (
              await api('/v1/objects/archive', {
                headers: { authorization: 'Bearer reader-token-1234567890' },
              })
            ).status,
            403,
          )
          const target = written.replicas[0]
          assert.equal((await api(`/v1/nodes/${target}/drain`, { method: 'POST' })).status, 202)
          let drained = false
          const end = Date.now() + 15000
          while (Date.now() < end) {
            const snapshot = await (await api('/v1/cluster')).json()
            if (!snapshot.nodes.some((n) => n.id === target)) {
              drained = true
              break
            }
            await api('/v1/repair', { method: 'POST' })
            await new Promise((r) => setTimeout(r, 150))
          }
          assert(drained, 'node must be removed after replacement replicas are verified')
          assert.equal(digest(Buffer.from(await (await get('large.bin')).arrayBuffer())), written.sha256)
          assert.equal(await (await api('/v1/objects/archive/test.txt')).text(), 'durable archive')
        },
      )
      await t.test('abruptly restarting all processes preserves acknowledged data and deletion', async () => {
        await put('deleted', 'old value')
        assert.equal((await api('/v1/objects/default/deleted', { method: 'DELETE' })).status, 200)
        await kill(gateway)
        for (const s of services) await kill(s)
        for (let i = 0; i < services.length; i++)
          services[i] = await launch('storage.mjs', { ...services[i].env, PORT: String(services[i].port) })
        gateway = await launch('gateway.mjs', env)
        base = `http://127.0.0.1:${gateway.port}`
        const response = await get('large.bin')
        assert.equal(response.status, 200)
        assert.equal(digest(Buffer.from(await response.arrayBuffer())), written.sha256)
        assert.equal((await get('deleted')).status, 404)
        const replay = await put('large.bin', body, { 'idempotency-key': 'large-1' })
        assert.equal((await replay.json()).version, written.version)
      })
    } finally {
      if (gateway) await kill(gateway)
      for (const child of [...children]) {
        const done = new Promise((r) => child.once('exit', r))
        child.kill('SIGKILL')
        await done
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
)
