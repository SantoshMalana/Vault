import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  assert,
  atomicJson,
  directoryLock,
  equalSecret,
  fail,
  fileHash,
  integer,
  httpServer,
  json,
  spaceAvailable,
  spool,
  syncDirectory,
} from './common.mjs'

export async function startStorage(options = {}) {
  const id = options.id || process.env.NODE_ID || 'n1'
  const directory = options.directory || process.env.DATA_DIR || `.vault/${id}`
  const token = options.token || process.env.NODE_TOKEN
  assert(token && token.length >= 16, 500, 'NODE_TOKEN must contain at least 16 characters')
  const maxBytes = integer(options.maxBytes || process.env.MAX_OBJECT_BYTES, 1024 ** 3)
  const maxInflight = integer(options.maxInflight || process.env.MAX_INFLIGHT, 32)
  const reserve = integer(options.reserve ?? process.env.DISK_RESERVE_BYTES, 16 * 1024 ** 2, 0)
  const root = join(directory, 'replicas'),
    temporary = join(directory, 'temporary')
  await mkdir(root, { recursive: true })
  await mkdir(temporary, { recursive: true })
  const release = await directoryLock(directory)
  // Temporary files have never been acknowledged; only this node owns this directory.
  for (const name of await readdir(temporary))
    if (/^[a-f0-9-]+\.part$/.test(name)) await rm(join(temporary, name), { force: true })
  const receipts = new Map(),
    invalid = new Set(),
    writing = new Set()
  for (const name of await readdir(root)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
    try {
      const item = JSON.parse(await readFile(join(root, name), 'utf8'))
      receipts.set(name.slice(0, -5), item)
    } catch {
      invalid.add(name.slice(0, -5))
    }
  }
  let inflight = 0,
    scrubbed = 0,
    scrubIndex = 0,
    busy = false
  async function verify(replica) {
    const receipt = receipts.get(replica)
    if (!receipt) return false
    const good = await fileHash(join(root, `${replica}.bin`))
      .then((h) => h === receipt.sha256)
      .catch(() => false)
    if (good) invalid.delete(replica)
    else invalid.add(replica)
    return good
  }
  const scrub = setInterval(
    async () => {
      if (busy || !receipts.size) return
      busy = true
      try {
        const ids = [...receipts.keys()]
        await verify(ids[scrubIndex++ % ids.length])
        scrubbed++
      } finally {
        busy = false
      }
    },
    integer(options.scrubMs || process.env.SCRUB_INTERVAL_MS, 2000),
  )
  scrub.unref()
  const server = await httpServer(async (req, res) => {
    let entered = false
    try {
      assert(
        equalSecret(req.headers.authorization?.replace(/^Bearer /, ''), token),
        401,
        'Unauthorized node request',
      )
      assert(inflight < maxInflight, 503, 'Node is busy; retry with backoff')
      inflight++
      entered = true
      const url = new URL(req.url, 'http://node')
      if (url.pathname === '/health' && req.method === 'GET') {
        const disk = await statfs(directory)
        return json(res, 200, {
          id,
          status: 'ready',
          objects: receipts.size,
          bytes: [...receipts.values()].reduce((n, r) => n + r.size, 0),
          freeBytes: disk.bavail * disk.bsize,
          inflight: inflight - 1,
          corrupt: invalid.size,
          scrubbed,
          corruptIds: [...invalid].slice(0, 100),
        })
      }
      const match = /^\/replicas\/([a-f0-9]{64})(\/verify)?$/.exec(url.pathname)
      assert(match, 404, 'Unknown node endpoint')
      const replica = match[1],
        path = join(root, `${replica}.bin`),
        meta = join(root, `${replica}.json`)
      if (match[2] && req.method === 'GET')
        return json(res, 200, { valid: await verify(replica), receipt: receipts.get(replica) || null })
      if (req.method === 'PUT') {
        assert(!writing.has(replica), 409, 'This replica is already being written')
        const expectedSize = integer(req.headers['content-length'], -1, 0, maxBytes)
        const expectedHash = req.headers['x-content-sha256']
        assert(/^[a-f0-9]{64}$/.test(expectedHash || ''), 400, 'A SHA-256 digest is required')
        const existing = receipts.get(replica)
        assert(
          !existing || (existing.sha256 === expectedHash && existing.size === expectedSize),
          409,
          'Immutable replica identifier has conflicting content',
        )
        await spaceAvailable(directory, expectedSize, reserve)
        writing.add(replica)
        const temp = join(temporary, `${randomUUID()}.part`)
        try {
          const receipt = await spool(req, temp, {
            maxBytes,
            expectedSize,
            expectedHash,
            signal: AbortSignal.timeout(120000),
          })
          // Windows rename cannot replace an open destination. A repair retries if a reader holds it.
          await rename(temp, path)
          await syncDirectory(root)
          const record = { ...receipt, storedAt: Date.now() }
          await atomicJson(meta, record)
          receipts.set(replica, record)
          invalid.delete(replica)
          return json(res, 201, { durable: true, id, replica, ...record })
        } finally {
          writing.delete(replica)
          await rm(temp, { force: true })
        }
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        const receipt = receipts.get(replica)
        assert(receipt && !invalid.has(replica), 404, 'Intact replica not available')
        const info = await stat(path).catch(() => null)
        assert(info?.size === receipt.size, 404, 'Replica bytes missing')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': receipt.size,
          'x-content-sha256': receipt.sha256,
        })
        if (req.method === 'HEAD') return res.end()
        await pipeline(createReadStream(path), res)
        return
      }
      // Replica retirement is intentionally disabled until distributed reader leases exist.
      assert(false, 405, 'Method not supported')
    } catch (error) {
      if (!error.status) console.error(JSON.stringify({ service: id, error: error.message }))
      fail(res, error)
    } finally {
      if (entered) inflight--
    }
  })
  server.requestTimeout = 120000
  server.headersTimeout = 15000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(
      options.port ?? Number(process.env.PORT || 7401),
      options.host || process.env.HOST || '127.0.0.1',
      resolve,
    )
  })
  return {
    server,
    port: server.address().port,
    directory,
    close: async () => {
      clearInterval(scrub)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await release()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await startStorage()
  console.log(
    JSON.stringify({
      service: 'storage',
      node: process.env.NODE_ID || 'n1',
      port: service.port,
      status: 'ready',
    }),
  )
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => service.close().then(() => process.exit(0)))
}
