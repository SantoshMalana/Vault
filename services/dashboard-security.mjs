// @ts-check

/** @typedef {Pick<Request, 'url' | 'headers'>} BrowserRequest */
/** @typedef {Record<string, string | undefined>} Environment */

/** Reject malformed origins, cross-site requests and protocol mismatches.
 * @param {BrowserRequest} req
 * @param {Environment} env
 */
export function sameOrigin(req, env = process.env) {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false
  const origin = req.headers.get('origin')
  if (!origin) return true // Non-browser clients still require authentication.
  try {
    const supplied = new URL(origin)
    const expected = new URL(env.VAULT_PUBLIC_ORIGIN || req.url)
    return (
      ['http:', 'https:'].includes(supplied.protocol) &&
      supplied.origin === expected.origin &&
      origin === supplied.origin
    )
  } catch {
    return false
  }
}

/** @param {BrowserRequest} req @param {Environment} env */
export function secureCookie(req, env = process.env) {
  return (
    new URL(env.VAULT_PUBLIC_ORIGIN || req.url).protocol === 'https:' ||
    env.VAULT_COOKIE_SECURE === 'true' ||
    (env.NODE_ENV === 'production' && env.VAULT_COOKIE_SECURE !== 'false')
  )
}

/** Only trust a client address header when an operator names a header their ingress overwrites.
 * @param {BrowserRequest} req @param {Environment} env
 */
export function loginSource(req, env = process.env) {
  const header = env.VAULT_CLIENT_IP_HEADER
  const value = header && req.headers.get(header)?.trim()
  return value && value.length <= 128 ? value : 'shared'
}

export class LoginLimiter {
  /** @type {Map<string, {count: number, until: number}>} */
  entries = new Map()
  /** @param {number} limit @param {number} windowMs @param {number} capacity */
  constructor(limit = 10, windowMs = 60000, capacity = 10000) {
    this.limit = limit
    this.windowMs = windowMs
    this.capacity = capacity
  }
  /** Fixed windows do not extend indefinitely when requests are rejected.
   * @param {string} source @param {number} now
   */
  take(source, now = Date.now()) {
    let entry = this.entries.get(source)
    if (entry && entry.until <= now) {
      this.entries.delete(source)
      entry = undefined
    }
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        for (const [key, value] of this.entries) if (value.until <= now) this.entries.delete(key)
        // Never clear active limits to make room for attacker-controlled identities.
        if (this.entries.size >= this.capacity)
          return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) }
      }
      entry = { count: 0, until: now + this.windowMs }
      this.entries.set(source, entry)
    }
    if (entry.count >= this.limit)
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.until - now) / 1000)) }
    entry.count++
    return { allowed: true, retryAfter: 0 }
  }
}

export class SessionBodyError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Bound login JSON independently of Content-Length, including chunked requests.
 * @param {Request} req @param {number} limit
 * @returns {Promise<string>}
 */
export async function readLoginToken(req, limit = 4096) {
  const length = req.headers.get('content-length')
  if (length && Number(length) > limit) throw new SessionBodyError(413, 'Login request is too large.')
  if (!req.body) throw new SessionBodyError(400, 'Enter a valid access token.')
  const reader = req.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new SessionBodyError(413, 'Login request is too large.')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new SessionBodyError(400, 'Invalid login JSON.')
  }
  const token = body?.token
  if (
    typeof token !== 'string' ||
    token.length < 16 ||
    token.length > 1024 ||
    /[\s\x00-\x1f\x7f]/.test(token)
  )
    throw new SessionBodyError(400, 'Enter a valid access token.')
  return token
}
