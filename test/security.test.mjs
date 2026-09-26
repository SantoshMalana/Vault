import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sameOrigin,
  secureCookie,
  loginSource,
  LoginLimiter,
  readLoginToken,
  SessionBodyError,
} from '../services/dashboard-security.mjs'

const request = (headers = {}, url = 'https://vault.example/api/session') => new Request(url, { headers })

test('browser mutations require exact, well-formed origins and reject cross-site fetches', () => {
  assert.equal(sameOrigin(request({ origin: 'https://vault.example' }), {}), true)
  for (const origin of [
    'null',
    'garbage',
    'http://vault.example',
    'https://evil.example',
    'https://vault.example.evil.example',
    'https://vault.example/path',
    'https://user@vault.example',
  ])
    assert.equal(sameOrigin(request({ origin }), {}), false, origin)
  assert.equal(sameOrigin(request({ 'sec-fetch-site': 'cross-site' }), {}), false)
  assert.equal(sameOrigin(request(), {}), true)
  assert.equal(
    sameOrigin(request({ origin: 'https://vault.example' }, 'http://internal:3000/api/session'), {
      VAULT_PUBLIC_ORIGIN: 'https://vault.example',
    }),
    true,
  )
  assert.equal(
    sameOrigin(request({ origin: 'https://vault.example' }), { VAULT_PUBLIC_ORIGIN: 'invalid' }),
    false,
  )
})

test('HTTPS sessions are secure even when an insecure cookie override is supplied', () => {
  assert.equal(secureCookie(request(), { VAULT_COOKIE_SECURE: 'false' }), true)
  const local = request({}, 'http://localhost:3000/api/session')
  assert.equal(secureCookie(local, {}), false)
  assert.equal(secureCookie(local, { NODE_ENV: 'production' }), true)
  assert.equal(secureCookie(local, { NODE_ENV: 'production', VAULT_COOKIE_SECURE: 'false' }), false)
  assert.equal(secureCookie(local, { VAULT_PUBLIC_ORIGIN: 'https://vault.example' }), true)
})

test('untrusted forwarded addresses cannot bypass login limits', () => {
  assert.equal(loginSource(request({ 'x-forwarded-for': 'attacker-one' }), {}), 'shared')
  assert.equal(loginSource(request({ 'x-forwarded-for': 'attacker-two' }), {}), 'shared')
  assert.equal(
    loginSource(request({ 'x-real-ip': '192.0.2.1' }), { VAULT_CLIENT_IP_HEADER: 'x-real-ip' }),
    '192.0.2.1',
  )
})

test('login windows expire, blocked retries do not extend them, and map saturation fails closed', () => {
  const limits = new LoginLimiter(2, 1000, 2)
  assert.equal(limits.take('a', 0).allowed, true)
  assert.equal(limits.take('a', 100).allowed, true)
  assert.deepEqual(limits.take('a', 900), { allowed: false, retryAfter: 1 })
  assert.equal(limits.take('b', 950).allowed, true)
  assert.equal(limits.take('c', 950).allowed, false)
  assert.equal(limits.take('a', 999).allowed, false)
  assert.equal(limits.take('c', 1000).allowed, true)
  assert.equal(limits.entries.size, 2)
  assert.equal(limits.take('a', 2000).allowed, true)
})

test('login parsing handles null, malformed and oversized bodies including chunked streams', async () => {
  const login = (body, headers = {}) =>
    new Request('http://localhost/api/session', { method: 'POST', body, headers })
  assert.equal(
    await readLoginToken(login(JSON.stringify({ token: 'valid-token-12345678' }))),
    'valid-token-12345678',
  )
  for (const body of ['null', 'oops', '{}', '[]', JSON.stringify({ token: 'token with whitespace' })])
    await assert.rejects(
      readLoginToken(login(body)),
      (error) => error instanceof SessionBodyError && error.status === 400,
    )
  await assert.rejects(readLoginToken(login('x'.repeat(4097))), { status: 413 })
  await assert.rejects(readLoginToken(login('{}', { 'content-length': '5000' })), { status: 413 })
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(2048))
    },
    cancel() {
      cancelled = true
    },
  })
  const chunked = new Request('http://localhost/api/session', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  })
  await assert.rejects(readLoginToken(chunked), { status: 413 })
  assert.equal(cancelled, true)
})
