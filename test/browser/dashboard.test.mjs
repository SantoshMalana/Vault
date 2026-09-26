import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '../..')
const token = 'browser-fixture-token-1234567890'
const file = Buffer.from('Vault browser regression fixture\n')
const object = {
  key: 'fixture.txt',
  bucket: 'default',
  size: file.length,
  sha256: createHash('sha256').update(file).digest('hex'),
  version: 'fixture-version',
  holders: ['n1', 'n2', 'n3'],
  createdAt: Date.now(),
  contentType: 'text/plain',
}
const snapshot = {
  epoch: 1,
  role: 'admin',
  metadata: { mode: 'local-journal', healthy: true, highlyAvailable: false },
  nodes: ['n10', 'n3', 'n1', 'n2'].map((id) => ({ id, domain: `test-${id}`, up: true })),
  buckets: [{ name: 'default', n: 3, w: 2, r: 2, sloppy: false }],
  objects: 1,
  logicalBytes: file.length,
  physicalBytes: file.length * 3,
  underReplicated: 0,
  corruptReplicas: 0,
  counters: { writes: 1, reads: 0, errors: 0, repairs: 0, repairBytes: 0 },
  latency: { p50: 1, p99: 1 },
  repair: { running: false, last: null },
  events: [],
  metrics: [],
  limits: { maxObjectBytes: 1073741824 },
  durability: { directorySync: true, obsoleteReplicaGc: false },
}
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

// The gateway is a controlled fixture. Actual storage failures are covered by integration.test.mjs.
test('dashboard browser and session boundaries', { timeout: 180000 }, async (t) => {
  let failListing = false,
    delay = 0,
    uploaded = null
  const gateway = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'Invalid token' })
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    if (req.url === '/v1/cluster') return reply(200, snapshot)
    if (req.method === 'PUT') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      uploaded = Buffer.concat(chunks)
      return reply(201, { ok: true })
    }
    if (req.url.startsWith('/v1/objects/default?'))
      return reply(
        failListing ? 503 : 200,
        failListing ? { error: 'Fixture temporarily unavailable' } : { items: [object], nextCursor: null },
      )
    if (req.url === '/v1/objects/default/fixture.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="fixture.txt"',
      })
      return res.end(file)
    }
    return reply(404, { error: 'Not found' })
  })
  const gatewayPort = await listen(gateway)
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise((resolve) => reservation.close(resolve))
  const base = `http://127.0.0.1:${port}`
  const child = spawn(
    process.execPath,
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        VAULT_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
        VAULT_PUBLIC_ORIGIN: base,
        VAULT_COOKIE_SECURE: 'false',
        VAULT_CLIENT_IP_HEADER: '',
        VAULT_MODE: 'durable',
      },
    },
  )
  let logs = '',
    browser
  child.stdout.on('data', (data) => {
    logs += data
  })
  child.stderr.on('data', (data) => {
    logs += data
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 120; attempt++) {
      if (child.exitCode !== null) throw new Error(logs)
      try {
        await fetch(base, { signal: AbortSignal.timeout(2000) })
        ready = true
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    assert.ok(ready, logs)
    browser = await chromium.launch({
      headless: true,
      ...(process.env.VAULT_BROWSER_CHANNEL ? { channel: process.env.VAULT_BROWSER_CHANNEL } : {}),
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await t.test('session validation and security headers', async () => {
      for (const origin of ['null', 'malformed', 'https://evil.example']) {
        const response = await page.request.post(`${base}/api/session`, {
          headers: { origin },
          data: { token },
        })
        assert.equal(response.status(), 403)
      }
      const malformed = await page.request.post(`${base}/api/session`, { data: 'null' })
      assert.equal(malformed.status(), 400)
      const oversized = await page.request.post(`${base}/api/session`, { data: 'x'.repeat(5000) })
      assert.equal(oversized.status(), 413)
      const login = await page.request.post(`${base}/api/session`, {
        headers: { origin: base },
        data: { token },
      })
      assert.equal(login.status(), 200)
      assert.match(login.headers()['set-cookie'], /HttpOnly/i)
      assert.match(login.headers()['set-cookie'], /SameSite=strict/i)
      const home = await page.request.get(base)
      assert.equal(home.headers()['x-frame-options'], 'DENY')
      assert.equal(home.headers()['x-content-type-options'], 'nosniff')
      const rejectedWrite = await page.request.put(`${base}/api/v1/objects/default/fixture.txt`, {
        headers: { origin: 'https://evil.example' },
        data: file,
      })
      assert.equal(rejectedWrite.status(), 403)
    })
    await page.goto(base)
    await page.getByRole('button', { name: 'Upload object', exact: true }).waitFor()
    await t.test('numeric node order and refresh success, failure and retry', async () => {
      await page.getByRole('button', { name: /^Cluster/ }).click()
      assert.deepEqual(await page.locator('.vd-node-card h3').allTextContents(), ['n1', 'n2', 'n3', 'n10'])
      delay = 500
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      const refreshing = page.getByRole('button', { name: 'Refreshing…', exact: true })
      await refreshing.waitFor()
      assert.equal(await refreshing.isDisabled(), true)
      assert.equal(
        await page.locator('.vd-refresh-spinning').evaluate((el) => getComputedStyle(el).animationName),
        'vd-refresh-spin',
      )
      await page.getByText('Refresh complete. Cluster and objects are up to date.').waitFor()
      failListing = true
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await page.getByRole('alert').filter({ hasText: 'Refresh failed.' }).waitFor()
      assert.equal(await page.getByText('Refresh complete. Cluster and objects are up to date.').count(), 0)
      failListing = false
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
      await refreshing.waitFor()
      assert.equal(
        await page.locator('.vd-refresh-spinning').evaluate((el) => getComputedStyle(el).animationName),
        'none',
      )
      await page.getByText('Refresh complete. Cluster and objects are up to date.').waitFor()
      delay = 0
    })
    await t.test('modal keyboard containment, Escape and focus restoration', async () => {
      await page.getByRole('button', { name: 'Objects', exact: true }).click()
      const open = page.getByRole('button', { name: 'Upload object', exact: true })
      await open.click()
      const dialog = page.getByRole('dialog', { name: 'Upload an object' })
      await dialog.waitFor()
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab')
        assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true)
      }
      await page.keyboard.press('Shift+Tab')
      assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true)
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await open.evaluate((el) => el === document.activeElement), true)
      const details = page.getByRole('button', { name: /fixture.txt text\/plain/ })
      await details.click()
      await page.getByRole('dialog', { name: 'Object details' }).waitFor()
      await page.keyboard.press('Escape')
      assert.equal(await details.evaluate((el) => el === document.activeElement), true)
    })
    await t.test('upload and download through the real dashboard proxy', async () => {
      await page.getByRole('button', { name: 'Upload object', exact: true }).click()
      await page
        .locator('input[type=file]')
        .setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: file })
      await page.getByRole('button', { name: 'Upload & replicate' }).click()
      await page.getByText('fixture.txt committed to durable storage.').waitFor()
      assert.deepEqual(uploaded, file)
      const downloadEvent = page.waitForEvent('download')
      await page.getByRole('link', { name: 'Download fixture.txt', exact: true }).click()
      const download = await downloadEvent
      assert.deepEqual(await readFile(await download.path()), file)
    })
    await t.test('login flooding returns Retry-After despite spoofed forwarded addresses', async () => {
      let response
      for (let i = 0; i < 11; i++)
        response = await page.request.post(`${base}/api/session`, {
          data: {},
          headers: { 'x-forwarded-for': `192.0.2.${i}` },
        })
      assert.equal(response.status(), 429)
      assert.ok(Number(response.headers()['retry-after']) > 0)
    })
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    gateway.closeAllConnections()
    await new Promise((resolve) => gateway.close(resolve))
  }
})
