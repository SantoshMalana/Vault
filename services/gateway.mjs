import { createReadStream } from 'node:fs'
import { mkdir, readdir, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import {
  assert,
  equalSecret,
  fail,
  Fault,
  fetchDeadline,
  hash,
  integer,
  httpServer,
  directoryLock,
  json,
  readJson,
  spaceAvailable,
  spool,
  validateObject,
} from './common.mjs'
import { EtcdMetadata, LocalMetadata } from './metadata.mjs'

const CONFIG = '/vault/config',
  OBJECTS = '/vault/objects/',
  REQUESTS = '/vault/requests/'
const objectKey = (bucket, key) => `${OBJECTS}${bucket}/${Buffer.from(key).toString('base64url')}`
export function placement(nodes, bucket, key, n) {
  const ranked = nodes
    .filter((x) => !x.draining)
    .map((node) => ({ node, score: hash(`${bucket}/${key}:${node.id}`) }))
    .sort((a, b) => (a.score > b.score ? -1 : 1))
    .map((x) => x.node)
  const domains = new Set(),
    result = []
  for (const node of ranked)
    if (!domains.has(node.domain)) {
      result.push(node)
      domains.add(node.domain)
      if (result.length === n) break
    }
  return result
}
function validateNode(node) {
  assert(/^[a-z0-9-]{1,32}$/.test(node.id || ''), 400, 'Invalid node ID')
  let url
  try {
    url = new URL(node.url)
  } catch {
    throw new Fault(400, 'Invalid storage URL')
  }
  assert(
    ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/',
    400,
    'Node URL must be an HTTP(S) origin',
  )
  assert(
    typeof node.domain === 'string' && node.domain.length > 0 && node.domain.length <= 128,
    400,
    'A failure domain is required',
  )
  return { id: node.id, url: url.origin, domain: node.domain, draining: false }
}
function validatePolicy(input, nodes) {
  validateObject(input.name, 'key')
  const n = integer(input.n, 3, 1, 16),
    w = integer(input.w, 2, 1, n),
    r = integer(input.r, 2, 1, n)
  assert(
    n <= new Set(nodes.filter((x) => !x.draining).map((x) => x.domain)).size,
    400,
    'N exceeds the number of active failure domains',
  )
  return { name: input.name, n, w, r, sloppy: input.sloppy === true }
}
function parseRange(value, size) {
  if (!value) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  assert(match && (match[1] || match[2]) && size > 0, 416, 'Invalid byte range')
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] ? (match[2] ? Math.min(Number(match[2]), size - 1) : size - 1) : size - 1
  assert(
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && start < size,
    416,
    'Range is outside the object',
  )
  return { start, end }
}

export async function startGateway(options = {}) {
  const directory = options.directory || process.env.DATA_DIR || '.vault/gateway'
  const temporary = join(directory, 'temporary')
  await mkdir(temporary, { recursive: true })
  const nodeToken = options.nodeToken || process.env.NODE_TOKEN
  const adminToken = options.adminToken || process.env.ADMIN_TOKEN
  assert(nodeToken?.length >= 16, 500, 'NODE_TOKEN must contain at least 16 characters')
  const users =
    options.users ||
    (process.env.VAULT_USERS
      ? JSON.parse(process.env.VAULT_USERS)
      : [{ name: 'admin', role: 'admin', token: adminToken, buckets: ['*'] }])
  assert(
    users.length &&
      users.every(
        (u) =>
          u.token?.length >= 16 && ['admin', 'write', 'read'].includes(u.role) && Array.isArray(u.buckets),
      ),
    500,
    'Configure valid API credentials and roles',
  )
  const endpoints = options.etcdEndpoints || process.env.ETCD_ENDPOINTS?.split(',')
  const metadata =
    options.metadata ||
    (endpoints?.length
      ? new EtcdMetadata(endpoints, process.env.ETCD_TOKEN)
      : await new LocalMetadata().init(directory))
  if (process.env.NODE_ENV === 'production')
    assert(metadata.mode === 'etcd', 500, 'Production requires an etcd metadata quorum')
  const releaseTemporary = await directoryLock(temporary)
  // Staged files are never committed references. Recover disk after an interrupted request.
  for (const entry of await readdir(temporary))
    if (/^[a-f0-9-]+\.part$/.test(entry)) await rm(join(temporary, entry), { force: true })
  const initialNodes = (options.nodes || JSON.parse(process.env.STORAGE_NODES || '[]')).map(validateNode)
  const boot = await metadata.get(CONFIG)
  if (!boot.value) {
    assert(
      initialNodes.length >= 3 && new Set(initialNodes.map((n) => n.id)).size === initialNodes.length,
      500,
      'Bootstrap needs at least three unique storage nodes',
    )
    const policy = validatePolicy({ name: 'default', n: 3, w: 2, r: 2 }, initialNodes)
    await metadata.txn(
      [{ key: CONFIG, revision: 0 }],
      [
        {
          key: CONFIG,
          value: { epoch: 1, nodes: initialNodes, buckets: { default: policy }, createdAt: Date.now() },
        },
      ],
    )
  }
  const maxBytes = integer(options.maxBytes || process.env.MAX_OBJECT_BYTES, 1024 ** 3)
  const rpcMs = integer(options.rpcMs || process.env.RPC_TIMEOUT_MS, 30000)
  const maxInflight = integer(options.maxInflight || process.env.MAX_INFLIGHT, 32)
  const repairBytes = integer(options.repairBytes || process.env.REPAIR_BYTES_PER_TICK, 64 * 1024 ** 2)
  const health = new Map(),
    events = [],
    history = [],
    latencies = []
  const counters = {
    writes: 0,
    reads: 0,
    deletes: 0,
    errors: 0,
    repairs: 0,
    repairBytes: 0,
    checksumFailures: 0,
  }
  let inflight = 0,
    repairBusy = false,
    repairCursor = '',
    lastRepair = null,
    stopped = false
  let sample = { puts: 0, gets: 0, deletes: 0, errors: 0 }
  function event(level, kind, message, details = {}) {
    const e = { id: randomUUID(), ts: Date.now(), level, kind, message, ...details }
    events.push(e)
    if (events.length > 200) events.shift()
    return e
  }
  function audit(user, action, details) {
    const record = { ts: new Date().toISOString(), actor: user.name || user.role, action, ...details }
    return appendFile(join(directory, 'audit.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
  }
  const canBucket = (user, bucket) =>
    user.role === 'admin' || user.buckets.includes('*') || user.buckets.includes(bucket)
  function authorize(req, bucket, write = false, admin = false) {
    const supplied = req.headers.authorization?.replace(/^Bearer /, '') || ''
    const user = users.find((u) => equalSecret(supplied, u.token))
    assert(user, 401, 'An access token is required')
    assert(!admin || user.role === 'admin', 403, 'Administrator permission required')
    assert(!write || user.role !== 'read', 403, 'Read-only access token')
    assert(!bucket || canBucket(user, bucket), 403, 'Bucket access denied')
    return user
  }
  async function rpc(node, path, init = {}, timeout = rpcMs) {
    return fetchDeadline(
      `${node.url}${path}`,
      { ...init, headers: { ...init.headers, authorization: `Bearer ${nodeToken}` } },
      timeout,
    )
  }
  async function probe(node) {
    try {
      const res = await rpc(node, '/health', {}, Math.min(rpcMs, 1500))
      assert(res.ok, 503, 'Node is unavailable')
      const data = await res.json()
      assert(data.id === node.id, 503, 'Node identity mismatch')
      const value = { ...data, up: true, lastSeen: Date.now() }
      health.set(node.id, value)
      return value
    } catch {
      const value = { ...health.get(node.id), up: false, status: 'unreachable' }
      health.set(node.id, value)
      return value
    }
  }
  async function putReplica(node, manifest, file) {
    const response = await rpc(node, `/replicas/${manifest.id}`, {
      method: 'PUT',
      headers: { 'content-length': String(manifest.size), 'x-content-sha256': manifest.sha256 },
      body: createReadStream(file),
      duplex: 'half',
    })
    assert(response.ok, 503, `${node.id} could not store a durable replica`)
    const ack = await response.json()
    assert(
      ack.durable && ack.sha256 === manifest.sha256 && ack.size === manifest.size,
      502,
      'Replica acknowledgement failed validation',
    )
    return node.id
  }
  async function availableReplica(node, manifest, verify = false) {
    try {
      const response = await rpc(node, `/replicas/${manifest.id}${verify ? '/verify' : ''}`, {
        method: verify ? 'GET' : 'HEAD',
      })
      if (!response.ok) {
        await response.body?.cancel()
        return false
      }
      if (verify) {
        const result = await response.json()
        return (
          result.valid && result.receipt?.sha256 === manifest.sha256 && result.receipt?.size === manifest.size
        )
      }
      return (
        response.headers.get('x-content-sha256') === manifest.sha256 &&
        Number(response.headers.get('content-length')) === manifest.size
      )
    } catch {
      return false
    }
  }
  async function downloadVerified(manifest, nodes, path) {
    for (const node of nodes) {
      try {
        const response = await rpc(node, `/replicas/${manifest.id}`)
        if (!response.ok) {
          await response.body?.cancel()
          continue
        }
        await spool(response.body, path, {
          maxBytes,
          expectedSize: manifest.size,
          expectedHash: manifest.sha256,
          signal: AbortSignal.timeout(rpcMs),
        })
        return node.id
      } catch (e) {
        await rm(path, { force: true })
        if (e.status === 422) {
          counters.checksumFailures++
          event('error', 'integrity', `Checksum failure on ${node.id}`, {
            object: `${manifest.bucket}/${manifest.key}`,
          })
        }
      }
    }
    throw new Fault(503, 'No intact reachable replica; object bytes were not returned')
  }
  async function allRecords(prefix) {
    const result = []
    let after = ''
    while (true) {
      const rows = await metadata.list(prefix, 500, after)
      result.push(...rows)
      if (rows.length < 500) break
      after = rows.at(-1).key
    }
    return result
  }
  const allObjects = () => allRecords(OBJECTS)
  function etag(manifest) {
    return `"${manifest.version}"`
  }
  function precondition(req, current) {
    if (req.headers['if-match'])
      assert(
        current &&
          !current.deleted &&
          (req.headers['if-match'] === '*' || req.headers['if-match'] === etag(current)),
        412,
        'The object changed; refresh before overwriting',
      )
    if (req.headers['if-none-match']) {
      assert(req.headers['if-none-match'] === '*', 400, 'Only If-None-Match: * is supported for writes')
      assert(!current || current.deleted, 412, 'Object already exists')
    }
  }
  async function writeObject(req, res, bucket, key, deleted, user, transaction = {}) {
    const cfg = await metadata.get(CONFIG),
      policy = cfg.value.buckets[bucket]
    assert(policy, 404, 'Bucket does not exist')
    const recordKey = transaction.recordKey || objectKey(bucket, key),
      before = await metadata.get(recordKey)
    const requestId = req.headers['idempotency-key'] || randomUUID()
    assert(typeof requestId === 'string' && requestId.length <= 128, 400, 'Invalid idempotency key')
    const requestKey = REQUESTS + hash(`${hash(user.token)}:${bucket}/${key}:${requestId}`)
    const previous = await metadata.get(requestKey)
    const file = join(temporary, `${randomUUID()}.part`)
    try {
      let content = { size: 0, sha256: '', chunks: [], chunkSize: 1024 ** 2 }
      if (!deleted) {
        const length =
          req.headers['content-length'] === undefined
            ? undefined
            : integer(req.headers['content-length'], 0, 0, maxBytes)
        await spaceAvailable(directory, length ?? maxBytes)
        content = await spool(req, file, {
          maxBytes,
          expectedSize: length,
          signal: AbortSignal.timeout(120000),
        })
        if (req.headers['x-content-sha256'])
          assert(
            content.sha256 === req.headers['x-content-sha256'],
            422,
            'Client checksum does not match the upload',
          )
      }
      if (previous.value) {
        assert(
          previous.value.sha256 === content.sha256 && previous.value.deleted === deleted,
          409,
          'Idempotency key was already used for a different operation',
        )
        return json(res, 200, { ...previous.value.result, replayed: true })
      }
      precondition(req, before.value)
      const version = randomUUID(),
        id = hash(`${bucket}/${key}:${version}`)
      const manifest = {
        ...content,
        bucket,
        key,
        version,
        id,
        deleted,
        contentType: String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200),
        createdAt: Date.now(),
        holders: [],
        requestId,
        epoch: cfg.value.epoch,
      }
      const desired = placement(cfg.value.nodes, bucket, key, policy.n)
      assert(desired.length === policy.n, 503, 'Insufficient failure domains for this policy')
      if (!deleted) {
        const states = await Promise.all(
          cfg.value.nodes.filter((n) => !n.draining).map(async (n) => ({ node: n, health: await probe(n) })),
        )
        let targets = desired.filter((n) => states.find((s) => s.node.id === n.id)?.health.up)
        if (policy.sloppy && targets.length < policy.n) {
          const domains = new Set(targets.map((n) => n.domain))
          for (const { node, health: h } of states)
            if (h.up && !domains.has(node.domain) && targets.length < policy.n) {
              targets.push(node)
              domains.add(node.domain)
            }
        }
        assert(targets.length >= policy.w, 503, `Write quorum unavailable: need ${policy.w} durable replicas`)
        const writes = await Promise.allSettled(targets.map((n) => putReplica(n, manifest, file)))
        manifest.holders = writes.filter((x) => x.status === 'fulfilled').map((x) => x.value)
        assert(
          manifest.holders.length >= policy.w,
          503,
          `Durable write quorum not met: ${manifest.holders.length}/${policy.w}`,
        )
      }
      const result = {
        bucket,
        key,
        version,
        sha256: manifest.sha256,
        size: manifest.size,
        replicas: manifest.holders,
        n: policy.n,
        w: policy.w,
        deleted,
        committed: true,
      }
      const committed = await metadata.txn(
        [
          { key: CONFIG, revision: cfg.revision },
          { key: recordKey, revision: before.revision },
          { key: requestKey, revision: 0 },
          ...(transaction.compares || []),
        ],
        [
          { key: recordKey, value: manifest },
          { key: requestKey, value: { sha256: content.sha256, deleted, result } },
          ...(transaction.extraPuts ? transaction.extraPuts(result) : []),
        ],
      )
      if (!committed) {
        // An etcd response can be lost after commit; the transactional request record resolves the outcome.
        const resolved = await metadata.get(requestKey)
        if (resolved.value && resolved.value.sha256 === content.sha256 && resolved.value.deleted === deleted)
          return json(res, 200, { ...resolved.value.result, replayed: true })
        throw new Fault(409, 'Object or placement changed during upload; retry with the same idempotency key')
      }
      if (deleted) {
        counters.deletes++
        sample.deletes++
      } else {
        counters.writes++
        sample.puts++
      }
      event(
        'success',
        deleted ? 'delete' : 'write',
        `${deleted ? 'Deleted' : 'Committed'} ${bucket}/${key}`,
        { replicas: manifest.holders },
      )
      await audit(user, deleted ? 'delete' : 'put', { bucket, key, version, bytes: manifest.size })
      return json(res, deleted ? 200 : 201, result, {
        etag: etag(manifest),
        'x-content-sha256': manifest.sha256,
      })
    } finally {
      await rm(file, { force: true })
    }
  }

  async function multipart(req, res, parts, user) {
    if (parts.length === 2 && req.method === 'POST') {
      const input = await readJson(req)
      validateObject(input.bucket, input.key)
      authorize(req, input.bucket, true)
      const cfg = await metadata.get(CONFIG)
      assert(cfg.value.buckets[input.bucket], 404, 'Bucket does not exist')
      const id = randomUUID(),
        recordKey = `/vault/uploads/${id}`
      const session = {
        id,
        bucket: input.bucket,
        key: input.key,
        owner: hash(user.token),
        contentType: String(input.contentType || 'application/octet-stream').slice(0, 200),
        status: 'active',
        createdAt: Date.now(),
        expiresAt: Date.now() + 24 * 3600000,
      }
      await metadata.txn([{ key: recordKey, revision: 0 }], [{ key: recordKey, value: session }])
      return json(res, 201, { uploadId: id, partSize: 8 * 1024 ** 2, expiresAt: session.expiresAt })
    }
    assert(/^[a-f0-9-]{36}$/.test(parts[2] || ''), 400, 'Invalid upload identifier')
    const sessionKey = `/vault/uploads/${parts[2]}`,
      record = await metadata.get(sessionKey),
      session = record.value
    assert(session, 404, 'Upload not found')
    authorize(req, session.bucket, req.method !== 'GET')
    assert(
      session.owner === hash(user.token) || user.role === 'admin',
      403,
      'Upload belongs to another credential',
    )
    const partPrefix = `/vault/upload-parts/${session.id}/`
    if (parts.length === 3 && req.method === 'GET') {
      const rows = await metadata.list(partPrefix, 1000)
      return json(res, 200, {
        uploadId: session.id,
        status: session.status,
        result: session.result || null,
        parts: rows.map((r) => ({
          number: Number(r.key.slice(partPrefix.length)),
          size: r.value.size,
          sha256: r.value.sha256,
        })),
      })
    }
    assert(
      session.status !== 'aborted' && session.expiresAt > Date.now(),
      409,
      'Upload is aborted or expired',
    )
    if (parts.length === 3 && req.method === 'DELETE') {
      assert(session.status !== 'complete', 409, 'A committed upload cannot be cancelled')
      assert(
        await metadata.txn(
          [{ key: sessionKey, revision: record.revision }],
          [{ key: sessionKey, value: { ...session, status: 'aborted' } }],
        ),
        409,
        'Upload changed; retry',
      )
      return json(res, 200, { aborted: true })
    }
    if (parts[3] === 'parts' && req.method === 'PUT') {
      assert(session.status === 'active', 409, 'Upload is already completing')
      const number = integer(parts[4], 0, 1, 1000)
      const length = integer(req.headers['content-length'], -1, 0, 16 * 1024 ** 2)
      assert(length <= maxBytes, 413, 'Part exceeds object size limit')
      return writeObject(
        req,
        res,
        session.bucket,
        `${session.key}/upload-${session.id}/part-${number}`,
        false,
        user,
        {
          recordKey: `${partPrefix}${String(number).padStart(4, '0')}`,
          compares: [{ key: sessionKey, revision: record.revision }],
        },
      )
    }
    if (parts[3] === 'complete' && req.method === 'POST') {
      if (session.status === 'complete') return json(res, 200, session.result)
      const input = await readJson(req, 256 * 1024)
      assert(
        Array.isArray(input.parts) && input.parts.length > 0 && input.parts.length <= 1000,
        400,
        'Provide the ordered part numbers and checksums',
      )
      const signature = hash(JSON.stringify(input.parts))
      let current = record
      if (session.status === 'active') {
        assert(
          await metadata.txn(
            [{ key: sessionKey, revision: record.revision }],
            [{ key: sessionKey, value: { ...session, status: 'assembling', signature } }],
          ),
          409,
          'Upload changed; retry',
        )
        current = await metadata.get(sessionKey)
      }
      assert(
        current.value.signature === signature,
        409,
        'Completion was already started with different parts',
      )
      const manifests = []
      for (let i = 0; i < input.parts.length; i++) {
        const part = input.parts[i]
        assert(
          part.number === i + 1 && /^[a-f0-9]{64}$/.test(part.sha256 || ''),
          400,
          'Parts must be contiguous, ordered and checksummed',
        )
        const { value } = await metadata.get(`${partPrefix}${String(part.number).padStart(4, '0')}`)
        assert(
          value && value.sha256 === part.sha256,
          409,
          `Part ${part.number} is missing or its checksum differs`,
        )
        manifests.push(value)
      }
      const size = manifests.reduce((n, m) => n + m.size, 0)
      assert(size <= maxBytes, 413, 'Combined object exceeds configured size limit')
      const cfg = await metadata.get(CONFIG)
      async function* assemble() {
        for (const manifest of manifests) {
          const file = join(temporary, `${randomUUID()}.part`)
          try {
            await downloadVerified(
              manifest,
              cfg.value.nodes.filter((n) => manifest.holders.includes(n.id)),
              file,
            )
            yield* createReadStream(file)
          } finally {
            await rm(file, { force: true })
          }
        }
      }
      const body = Readable.from(assemble())
      body.headers = {
        'content-length': String(size),
        'content-type': session.contentType,
        'idempotency-key': `complete-${session.id}`,
        ...(req.headers['if-match'] ? { 'if-match': req.headers['if-match'] } : {}),
      }
      return writeObject(body, res, session.bucket, session.key, false, user, {
        compares: [{ key: sessionKey, revision: current.revision }],
        extraPuts: (result) => [{ key: sessionKey, value: { ...current.value, status: 'complete', result } }],
      })
    }
    throw new Fault(404, 'Unknown multipart endpoint')
  }
  async function readObject(req, res, bucket, key, url) {
    const cfg = await metadata.get(CONFIG),
      policy = cfg.value.buckets[bucket]
    assert(policy, 404, 'Bucket does not exist')
    const { value: manifest } = await metadata.get(objectKey(bucket, key))
    assert(manifest && !manifest.deleted, 404, 'Object not found')
    if (req.headers['if-none-match'] === etag(manifest)) {
      res.writeHead(304, { etag: etag(manifest) })
      return res.end()
    }
    const consistency = url.searchParams.get('consistency') || 'quorum'
    assert(['one', 'quorum', 'all'].includes(consistency), 400, 'Invalid consistency option')
    const required = consistency === 'one' ? 1 : consistency === 'all' ? policy.n : policy.r
    const candidates = cfg.value.nodes.filter((n) => manifest.holders.includes(n.id))
    const replies = await Promise.all(
      candidates.map(async (node) => ({ node, good: await availableReplica(node, manifest) })),
    )
    const holders = replies.filter((x) => x.good).map((x) => x.node)
    assert(
      holders.length >= required,
      503,
      `Read availability threshold not met: ${holders.length}/${required}`,
    )
    const range = parseRange(req.headers.range, manifest.size)
    const headers = {
      etag: etag(manifest),
      'x-vault-version': manifest.version,
      'x-content-sha256': manifest.sha256,
      'accept-ranges': 'bytes',
      'content-type': manifest.contentType,
      'content-length': String(range ? range.end - range.start + 1 : manifest.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(key.split('/').pop())}`,
      'cache-control': 'no-store',
    }
    if (range) headers['content-range'] = `bytes ${range.start}-${range.end}/${manifest.size}`
    if (req.method === 'HEAD') {
      res.writeHead(range ? 206 : 200, headers)
      return res.end()
    }
    const file = join(temporary, `${randomUUID()}.part`)
    try {
      await spaceAvailable(directory, manifest.size)
      const source = await downloadVerified(manifest, holders, file)
      headers['x-vault-served-by'] = source
      res.writeHead(range ? 206 : 200, headers)
      await pipeline(createReadStream(file, range || {}), res)
      counters.reads++
      sample.gets++
    } finally {
      await rm(file, { force: true })
    }
  }

  async function repairTick() {
    if (repairBusy || stopped) return { busy: true }
    repairBusy = true
    let examined = 0,
      moved = 0,
      repaired = 0
    try {
      const cfg = await metadata.get(CONFIG)
      await Promise.all(cfg.value.nodes.map(probe))
      let rows = await metadata.list(OBJECTS, 8, repairCursor)
      if (!rows.length) {
        repairCursor = ''
        rows = await metadata.list(OBJECTS, 8)
      }
      for (const row of rows) {
        if (stopped || moved >= repairBytes) break
        repairCursor = row.key
        examined++
        const manifest = row.value,
          policy = cfg.value.buckets[manifest.bucket]
        if (manifest.deleted || !policy) continue
        const desired = placement(cfg.value.nodes, manifest.bucket, manifest.key, policy.n)
        const old = cfg.value.nodes.filter((n) => manifest.holders.includes(n.id))
        const candidates = [...new Map([...old, ...desired].map((n) => [n.id, n])).values()].filter(
          (n) => health.get(n.id)?.up,
        )
        const verified = await Promise.all(
          candidates.map(async (node) => ({ node, good: await availableReplica(node, manifest, true) })),
        )
        const good = verified.filter((r) => r.good).map((r) => r.node)
        if (!good.length) {
          event('error', 'repair', `No intact source for ${manifest.bucket}/${manifest.key}`)
          continue
        }
        const wanted = [...desired]
        // Rebuild redundancy on spare domains while designated owners remain unavailable.
        const domains = new Set(wanted.filter((n) => health.get(n.id)?.up).map((n) => n.domain))
        for (const node of cfg.value.nodes)
          if (
            !node.draining &&
            health.get(node.id)?.up &&
            !domains.has(node.domain) &&
            domains.size < policy.n
          ) {
            wanted.push(node)
            domains.add(node.domain)
          }
        const missing = wanted.filter((n) => health.get(n.id)?.up && !good.some((g) => g.id === n.id))
        if (missing.length) {
          const file = join(temporary, `${randomUUID()}.part`)
          try {
            await spaceAvailable(directory, manifest.size)
            await downloadVerified(manifest, good, file)
            for (const target of missing) {
              if (moved >= repairBytes) break
              try {
                await putReplica(target, manifest, file)
                good.push(target)
                moved += manifest.size
                repaired++
              } catch (error) {
                event('warn', 'repair', `Replica repair on ${target.id} will retry: ${error.message}`, {
                  object: `${manifest.bucket}/${manifest.key}`,
                })
              }
            }
          } finally {
            await rm(file, { force: true })
          }
        }
        const fullyRestored = new Set(good.filter((n) => !n.draining).map((n) => n.domain)).size >= policy.n
        const holders = [...new Set([...manifest.holders, ...good.map((n) => n.id)])]
          .filter((id) => !fullyRestored || !cfg.value.nodes.find((n) => n.id === id)?.draining)
          .sort()
        if (holders.join() !== [...manifest.holders].sort().join())
          await metadata.txn(
            [
              { key: CONFIG, revision: cfg.revision },
              { key: row.key, revision: row.revision },
            ],
            [{ key: row.key, value: { ...manifest, holders } }],
          )
      }
      if (cfg.value.nodes.some((n) => n.draining)) {
        const uploads = await allRecords('/vault/uploads/')
        if (
          !uploads.some(
            ({ value: u }) => ['active', 'assembling'].includes(u.status) && u.expiresAt > Date.now(),
          )
        ) {
          const objects = await allObjects()
          const drained = cfg.value.nodes.filter(
            (n) => n.draining && !objects.some(({ value: m }) => !m.deleted && m.holders.includes(n.id)),
          )
          if (
            drained.length &&
            (await metadata.txn(
              [{ key: CONFIG, revision: cfg.revision }],
              [
                {
                  key: CONFIG,
                  value: {
                    ...cfg.value,
                    epoch: cfg.value.epoch + 1,
                    nodes: cfg.value.nodes.filter((n) => !drained.includes(n)),
                  },
                },
              ],
            ))
          ) {
            for (const node of drained)
              event('success', 'membership', `${node.id} drained and removed; its disk remains untouched`)
          }
        }
      }
      counters.repairs += repaired
      counters.repairBytes += moved
      lastRepair = { at: Date.now(), examined, replicasRepaired: repaired, bytesMoved: moved }
      if (repaired) event('success', 'repair', `Restored ${repaired} replicas`, { bytes: moved })
      return lastRepair
    } catch (e) {
      event('warn', 'repair', e.message)
      return { error: e.message }
    } finally {
      repairBusy = false
    }
  }

  async function snapshot(user) {
    const cfg = await metadata.get(CONFIG)
    const nodes = await Promise.all(cfg.value.nodes.map(async (n) => ({ ...n, ...(await probe(n)) })))
    const rows = (await allObjects()).filter((x) => canBucket(user, x.value.bucket))
    const live = rows.filter((r) => !r.value.deleted)
    const buckets = Object.values(cfg.value.buckets)
      .filter((b) => canBucket(user, b.name))
      .map((b) => ({
        ...b,
        objects: live.filter((o) => o.value.bucket === b.name).length,
        bytes: live.filter((o) => o.value.bucket === b.name).reduce((n, o) => n + o.value.size, 0),
      }))
    let underReplicated = 0
    for (const { value: m } of live) {
      const n = cfg.value.buckets[m.bucket]?.n || 3
      if (
        m.holders.filter((id) => nodes.find((x) => x.id === id && x.up && !x.corruptIds?.includes(m.id)))
          .length < n
      )
        underReplicated++
    }
    const ordered = [...latencies].sort((a, b) => a - b)
    return {
      mode: 'durable',
      epoch: cfg.value.epoch,
      metadata: await metadata.health(),
      role: user.role,
      nodes:
        user.role === 'admin'
          ? nodes
          : nodes.map((node) => {
              const visible = { ...node }
              delete visible.url
              delete visible.corruptIds
              return visible
            }),
      buckets,
      objects: live.length,
      logicalBytes: live.reduce((n, r) => n + r.value.size, 0),
      physicalBytes: nodes.reduce((n, x) => n + (x.bytes || 0), 0),
      underReplicated,
      corruptReplicas: nodes.reduce((n, x) => n + (x.corrupt || 0), 0),
      counters,
      repair: { running: repairBusy, last: lastRepair },
      metrics: history,
      latency: {
        p50: ordered[Math.floor(ordered.length * 0.5)] || 0,
        p99: ordered[Math.floor(ordered.length * 0.99)] || 0,
      },
      events: user.role === 'admin' ? events.slice(-50).reverse() : [],
      limits: { maxObjectBytes: maxBytes, maxInflight, rpcTimeoutMs: rpcMs },
      durability: { directorySync: process.platform !== 'win32', obsoleteReplicaGc: false },
    }
  }

  const server = await httpServer(async (req, res) => {
    const started = Date.now()
    let entered = false
    try {
      const url = new URL(req.url, 'http://gateway'),
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (url.pathname === '/healthz') {
        const h = await metadata.health()
        return json(res, h.healthy ? 200 : 503, { ready: h.healthy, metadata: h.mode })
      }
      const user = authorize(req)
      assert(inflight < maxInflight, 503, 'Gateway is busy; retry with backoff')
      inflight++
      entered = true
      if (url.pathname === '/v1/cluster' && req.method === 'GET') return json(res, 200, await snapshot(user))
      if (parts[0] === 'v1' && parts[1] === 'uploads') return await multipart(req, res, parts, user)
      if (url.pathname === '/v1/repair' && req.method === 'POST') {
        authorize(req, undefined, true, true)
        await audit(user, 'repair', {})
        void repairTick()
        return json(res, 202, { scheduled: true })
      }
      if (url.pathname === '/v1/buckets') {
        const cfg = await metadata.get(CONFIG)
        if (req.method === 'GET')
          return json(
            res,
            200,
            Object.values(cfg.value.buckets).filter((b) => canBucket(user, b.name)),
          )
        authorize(req, undefined, true, true)
        if (req.method === 'PUT') {
          const policy = validatePolicy(await readJson(req), cfg.value.nodes)
          const next = {
            ...cfg.value,
            epoch: cfg.value.epoch + 1,
            buckets: { ...cfg.value.buckets, [policy.name]: policy },
          }
          assert(
            await metadata.txn([{ key: CONFIG, revision: cfg.revision }], [{ key: CONFIG, value: next }]),
            409,
            'Configuration changed; retry',
          )
          await audit(user, 'set-bucket', policy)
          return json(res, 200, policy)
        }
      }
      if (url.pathname === '/v1/nodes' && req.method === 'POST') {
        authorize(req, undefined, true, true)
        const cfg = await metadata.get(CONFIG),
          node = validateNode(await readJson(req))
        assert(
          !cfg.value.nodes.some((n) => n.id === node.id || n.url === node.url),
          409,
          'Node ID or address already registered',
        )
        assert((await probe(node)).up, 503, 'Node failed authentication or health verification')
        const next = { ...cfg.value, epoch: cfg.value.epoch + 1, nodes: [...cfg.value.nodes, node] }
        assert(
          await metadata.txn([{ key: CONFIG, revision: cfg.revision }], [{ key: CONFIG, value: next }]),
          409,
          'Configuration changed; retry',
        )
        await audit(user, 'add-node', node)
        event('info', 'membership', `${node.id} joined; recovery will reconcile placement`)
        return json(res, 201, node)
      }
      if (parts[0] === 'v1' && parts[1] === 'nodes' && parts[3] === 'drain' && req.method === 'POST') {
        authorize(req, undefined, true, true)
        const cfg = await metadata.get(CONFIG),
          target = cfg.value.nodes.find((n) => n.id === parts[2])
        assert(target, 404, 'Node does not exist')
        const remaining = cfg.value.nodes.filter((n) => n.id !== target.id && !n.draining)
        const maxN = Math.max(...Object.values(cfg.value.buckets).map((b) => b.n), 1)
        assert(
          new Set(remaining.map((n) => n.domain)).size >= maxN,
          409,
          'Too few failure domains would remain',
        )
        const next = {
          ...cfg.value,
          epoch: cfg.value.epoch + 1,
          nodes: cfg.value.nodes.map((n) => (n.id === target.id ? { ...n, draining: true } : n)),
        }
        assert(
          await metadata.txn([{ key: CONFIG, revision: cfg.revision }], [{ key: CONFIG, value: next }]),
          409,
          'Configuration changed; retry',
        )
        await audit(user, 'drain-node', { node: target.id })
        event(
          'info',
          'membership',
          `${target.id} is draining; replacement replicas must be verified before removal`,
        )
        void repairTick()
        return json(res, 202, { draining: target.id })
      }
      if (parts[0] === 'v1' && parts[1] === 'objects' && parts[2]) {
        const bucket = parts[2],
          key = parts.slice(3).join('/')
        authorize(req, bucket, ['PUT', 'DELETE'].includes(req.method))
        if (!key && req.method === 'GET') {
          const cfg = await metadata.get(CONFIG)
          assert(cfg.value.buckets[bucket], 404, 'Bucket does not exist')
          const limit = integer(url.searchParams.get('limit') || undefined, 50, 1, 200)
          const cursor = url.searchParams.get('cursor') || ''
          const prefix = `${OBJECTS}${bucket}/`
          assert(!cursor || cursor.startsWith(prefix), 400, 'Invalid listing cursor')
          const rows = await metadata.list(prefix, limit + 1, cursor),
            page = rows.slice(0, limit)
          return json(res, 200, {
            items: page.filter((r) => !r.value.deleted).map((r) => r.value),
            nextCursor: rows.length > limit ? page.at(-1).key : null,
          })
        }
        validateObject(bucket, key)
        if (req.method === 'PUT' || req.method === 'DELETE')
          return await writeObject(req, res, bucket, key, req.method === 'DELETE', user)
        if (req.method === 'GET' || req.method === 'HEAD') return await readObject(req, res, bucket, key, url)
      }
      if (url.pathname === '/v1/metrics' && req.method === 'GET') {
        authorize(req, undefined, false, true)
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
        return res.end(
          Object.entries(counters)
            .map(
              ([key, value]) => `vault_${key.replace(/[A-Z]/g, (s) => '_' + s.toLowerCase())}_total ${value}`,
            )
            .join('\n') + '\n',
        )
      }
      throw new Fault(404, 'Unknown API endpoint')
    } catch (error) {
      counters.errors++
      sample.errors++
      if (!error.status) console.error(JSON.stringify({ service: 'gateway', error: error.message }))
      fail(res, error)
    } finally {
      if (entered) {
        inflight--
        latencies.push(Date.now() - started)
        if (latencies.length > 1000) latencies.shift()
      }
    }
  })
  server.requestTimeout = 120000
  server.headersTimeout = 15000
  const repairTimer = setInterval(
    () => void repairTick(),
    integer(options.repairMs || process.env.REPAIR_INTERVAL_MS, 3000),
  )
  repairTimer.unref()
  const metricsTimer = setInterval(() => {
    history.push({ ts: Date.now(), ...sample })
    if (history.length > 60) history.shift()
    sample = { puts: 0, gets: 0, deletes: 0, errors: 0 }
  }, 1000)
  metricsTimer.unref()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(
      options.port ?? Number(process.env.PORT || 7400),
      options.host || process.env.HOST || '127.0.0.1',
      resolve,
    )
  })
  return {
    server,
    port: server.address().port,
    repairTick,
    metadata,
    close: async () => {
      stopped = true
      clearInterval(repairTimer)
      clearInterval(metricsTimer)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      while (repairBusy) await new Promise((resolve) => setTimeout(resolve, 20))
      await metadata.close()
      await releaseTemporary()
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const service = await startGateway()
  console.log(
    JSON.stringify({
      service: 'gateway',
      port: service.port,
      status: 'ready',
      metadata: service.metadata.mode,
    }),
  )
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => service.close().then(() => process.exit(0)))
}
