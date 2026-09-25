import { createHash, timingSafeEqual, randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const CHUNK_BYTES = 1024 * 1024
export async function httpServer(handler) {
  const cert = process.env.TLS_CERT_FILE,
    key = process.env.TLS_KEY_FILE
  assert((!cert && !key) || (cert && key), 500, 'Configure both TLS_CERT_FILE and TLS_KEY_FILE')
  if (!cert) return createHttpServer(handler)
  return createHttpsServer(
    { cert: await readFile(cert), key: await readFile(key), minVersion: 'TLSv1.2' },
    handler,
  )
}
export const hash = (value) => createHash('sha256').update(value).digest('hex')
export class Fault extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
export const assert = (condition, status, message) => {
  if (!condition) throw new Fault(status, message)
}
export function equalSecret(a = '', b = '') {
  const x = Buffer.from(a),
    y = Buffer.from(b)
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}
export function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(value))
}
export function fail(res, error) {
  if (res.headersSent) return res.destroy()
  json(res, error.status || 500, {
    error: error.status ? error.message : 'Internal operation failed; inspect server logs.',
  })
}
export async function readJson(req, limit = 64 * 1024) {
  let size = 0
  const parts = []
  for await (const part of req) {
    size += part.length
    assert(size <= limit, 413, 'Request is too large')
    parts.push(part)
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString() || '{}')
  } catch {
    throw new Fault(400, 'Invalid JSON')
  }
}
export async function syncDirectory(path) {
  // Windows does not expose POSIX directory fsync; Linux is the supported durable deployment target.
  if (process.platform === 'win32') return
  const fd = await open(path, 'r')
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = await open(temp, 'wx', 0o600)
  try {
    await fd.writeFile(JSON.stringify(value))
    await fd.sync()
  } finally {
    await fd.close()
  }
  try {
    await rename(temp, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temp, { force: true })
  }
}
export async function spaceAvailable(path, required, reserve = 16 * 1024 * 1024) {
  const s = await statfs(path)
  assert(s.bavail * s.bsize >= required + reserve, 507, 'Insufficient free disk space')
}
export async function spool(readable, path, { maxBytes, expectedSize, expectedHash, signal } = {}) {
  let bytes = 0,
    chunkBytes = 0
  const whole = createHash('sha256')
  let chunk = createHash('sha256')
  const chunks = []
  const meter = new Transform({
    transform(data, encoding, callback) {
      try {
        bytes += data.length
        assert(!maxBytes || bytes <= maxBytes, 413, 'Object exceeds configured size limit')
        whole.update(data)
        let offset = 0
        while (offset < data.length) {
          const take = Math.min(CHUNK_BYTES - chunkBytes, data.length - offset)
          chunk.update(data.subarray(offset, offset + take))
          offset += take
          chunkBytes += take
          if (chunkBytes === CHUNK_BYTES) {
            chunks.push(chunk.digest('hex'))
            chunk = createHash('sha256')
            chunkBytes = 0
          }
        }
        callback(null, data)
      } catch (e) {
        callback(e)
      }
    },
  })
  try {
    await pipeline(readable, meter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal })
    if (chunkBytes || !chunks.length) chunks.push(chunk.digest('hex'))
    const sha256 = whole.digest('hex')
    assert(expectedSize === undefined || bytes === expectedSize, 422, 'Object size mismatch')
    assert(!expectedHash || sha256 === expectedHash, 422, 'Object checksum mismatch')
    const fd = await open(path, 'r+')
    try {
      await fd.sync()
    } finally {
      await fd.close()
    }
    return { size: bytes, sha256, chunks, chunkSize: CHUNK_BYTES }
  } catch (e) {
    await rm(path, { force: true })
    throw e
  }
}
export async function fileHash(path) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}
export function mutex() {
  let previous = Promise.resolve()
  return (fn) => {
    const result = previous.then(fn)
    previous = result.catch(() => {})
    return result
  }
}
export async function directoryLock(directory) {
  await mkdir(directory, { recursive: true })
  const path = `${directory}/owner.lock`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(path, 'wx', 0o600)
      try {
        await fd.writeFile(JSON.stringify({ pid: process.pid }))
        await fd.sync()
      } finally {
        await fd.close()
      }
      return () => rm(path, { force: true })
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let owner
      try {
        owner = JSON.parse(await readFile(path, 'utf8'))
      } catch {
        throw new Fault(
          500,
          'Unreadable storage ownership lock; verify no process uses this directory before removing owner.lock',
        )
      }
      let alive = true
      try {
        process.kill(owner.pid, 0)
      } catch (error) {
        if (error.code === 'ESRCH') alive = false
      }
      assert(!alive, 500, 'Another process owns this data directory')
      await rm(path, { force: true })
    }
  }
  throw new Fault(500, 'Could not acquire data directory ownership')
}
export function integer(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = value === undefined ? fallback : Number(value)
  assert(Number.isSafeInteger(n) && n >= min && n <= max, 400, 'Invalid integer setting')
  return n
}
export function validateObject(bucket, key) {
  assert(
    /^[a-z0-9][a-z0-9-]{1,31}$/.test(bucket),
    400,
    'Bucket must contain 2–32 lowercase letters, digits or dashes',
  )
  assert(
    typeof key === 'string' &&
      key.length > 0 &&
      Buffer.byteLength(key) <= 1024 &&
      !/[\x00-\x1f\x7f]/.test(key),
    400,
    'Invalid object key',
  )
}
export async function fetchDeadline(url, options = {}, ms = 10000) {
  return fetch(url, {
    ...options,
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(ms)])
      : AbortSignal.timeout(ms),
  })
}
