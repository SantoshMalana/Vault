import { mkdir, readFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { Fault, assert, mutex, fetchDeadline, syncDirectory, directoryLock } from './common.mjs'

const encode = (s) => Buffer.from(s).toString('base64')
const decode = (s) => Buffer.from(s || '', 'base64').toString()

// Local development: a single-writer, fsynced transaction journal. Production uses etcd.
export class LocalMetadata {
  mode = 'local-journal'
  records = new Map()
  revision = 0
  exclusive = mutex()
  async init(directory) {
    await mkdir(directory, { recursive: true })
    this.release = await directoryLock(directory)
    this.path = join(directory, 'metadata.wal')
    const data = await readFile(this.path, 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return ''
      throw e
    })
    const complete = data.lastIndexOf('\n') + 1
    for (const line of data.slice(0, complete).split('\n').filter(Boolean)) {
      const tx = JSON.parse(line)
      assert(tx.revision === this.revision + 1, 500, 'Metadata journal is corrupt')
      this.apply(tx)
    }
    // A crash can leave a partial final record. Only newline-terminated, fsynced records are acknowledged.
    if (complete < data.length) {
      const repair = await open(this.path, 'r+')
      try {
        await repair.truncate(Buffer.byteLength(data.slice(0, complete)))
        await repair.sync()
      } finally {
        await repair.close()
      }
    }
    this.fd = await open(this.path, 'a+', 0o600)
    await syncDirectory(directory)
    return this
  }
  apply(tx) {
    this.revision = tx.revision
    for (const { key, value } of tx.puts) this.records.set(key, { value, revision: tx.revision })
  }
  async get(key) {
    assert(!this.failed, 503, 'Metadata journal needs recovery after an I/O error')
    return structuredClone(this.records.get(key) || { value: null, revision: 0 })
  }
  async list(prefix, limit = 1000, after = '') {
    assert(!this.failed, 503, 'Metadata journal needs recovery after an I/O error')
    return [...this.records]
      .filter(([k]) => k.startsWith(prefix) && k > after)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([key, record]) => ({ key, ...structuredClone(record) }))
  }
  async txn(compares, puts) {
    return this.exclusive(async () => {
      assert(!this.failed, 503, 'Metadata journal needs recovery after an I/O error')
      if (!compares.every(({ key, revision }) => (this.records.get(key)?.revision || 0) === revision))
        return false
      const tx = { revision: this.revision + 1, puts }
      try {
        await this.fd.writeFile(JSON.stringify(tx) + '\n')
        await this.fd.sync()
        this.apply(tx)
      } catch (error) {
        this.failed = true
        throw error
      }
      return true
    })
  }
  async health() {
    return { mode: this.mode, healthy: !this.failed, revision: this.revision, highlyAvailable: false }
  }
  async close() {
    await this.exclusive(async () => {
      await this.fd.close()
      await this.release()
    })
  }
}

export class EtcdMetadata {
  mode = 'etcd'
  constructor(endpoints, token) {
    this.endpoints = endpoints
    this.token = token
  }
  async call(route, body) {
    for (const endpoint of this.endpoints) {
      try {
        const res = await fetchDeadline(
          `${endpoint}/v3/${route}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.token ? { authorization: this.token } : {}),
            },
            body: JSON.stringify(body),
          },
          3000,
        )
        const value = await res.json()
        if (res.ok && !value.error) return value
      } catch {
        /* Try the next configured member. Transactions use CAS to make retry outcomes safe. */
      }
    }
    throw new Fault(503, 'Metadata quorum unavailable; no writes or unverified reads can be authorized')
  }
  async get(key) {
    const result = await this.call('kv/range', { key: encode(key), serializable: false })
    const entry = result.kvs?.[0]
    return entry
      ? { value: JSON.parse(decode(entry.value)), revision: Number(entry.mod_revision) }
      : { value: null, revision: 0 }
  }
  async list(prefix, limit = 1000, after = '') {
    const end = Buffer.from(prefix)
    end[end.length - 1]++
    const result = await this.call('kv/range', {
      key: encode(after ? after + '\0' : prefix),
      range_end: end.toString('base64'),
      limit,
      sort_order: 'ASCEND',
      sort_target: 'KEY',
      serializable: false,
    })
    return (result.kvs || []).map((e) => ({
      key: decode(e.key),
      value: JSON.parse(decode(e.value)),
      revision: Number(e.mod_revision),
    }))
  }
  async txn(compares, puts) {
    const result = await this.call('kv/txn', {
      compare: compares.map(({ key, revision }) => ({
        key: encode(key),
        target: 'MOD',
        result: 'EQUAL',
        mod_revision: String(revision),
      })),
      success: puts.map(({ key, value }) => ({
        request_put: { key: encode(key), value: encode(JSON.stringify(value)) },
      })),
      failure: [],
    })
    return result.succeeded === true
  }
  async health() {
    try {
      await this.get('/vault/config')
      return { mode: this.mode, healthy: true, highlyAvailable: true }
    } catch {
      return { mode: this.mode, healthy: false, highlyAvailable: true }
    }
  }
  async close() {}
}
