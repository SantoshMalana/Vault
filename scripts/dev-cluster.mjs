import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..'),
  directory = join(root, '.vault')
await mkdir(directory, { recursive: true })
const secretsPath = join(directory, 'credentials.json')
let secrets
try {
  secrets = JSON.parse(await readFile(secretsPath, 'utf8'))
} catch (e) {
  if (e.code !== 'ENOENT') throw e
  secrets = { adminToken: randomBytes(32).toString('hex'), nodeToken: randomBytes(32).toString('hex') }
  await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' })
}
if (process.argv.includes('--token')) {
  console.log(secrets.adminToken)
  process.exit(0)
}
const services = [],
  nodes = Array.from({ length: 5 }, (_, i) => ({
    id: `n${i + 1}`,
    url: `http://127.0.0.1:${7401 + i}`,
    domain: `development-node-${i + 1}`,
  }))
let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  for (const service of services) service.kill()
  setTimeout(() => process.exit(0), 1500).unref()
}
function start(file, env) {
  const child = spawn(process.execPath, [join(root, file)], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development', ...env },
    stdio: 'inherit',
    windowsHide: true,
  })
  services.push(child)
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${file} exited (${code}). Stopping local cluster.`)
      stop()
    }
  })
}
for (let i = 0; i < nodes.length; i++)
  start('services/storage.mjs', {
    NODE_ID: nodes[i].id,
    PORT: String(7401 + i),
    NODE_TOKEN: secrets.nodeToken,
    DATA_DIR: join(directory, nodes[i].id),
  })
start('services/gateway.mjs', {
  PORT: '7400',
  NODE_TOKEN: secrets.nodeToken,
  ADMIN_TOKEN: secrets.adminToken,
  STORAGE_NODES: JSON.stringify(nodes),
  DATA_DIR: join(directory, 'gateway'),
})
console.log(
  '\nVault local cluster: five storage processes + one gateway.\nStart the dashboard in another terminal: npm run dev\nRetrieve your login token: npm run vault:token\nData persists in .vault/. Press Ctrl+C to stop.\nLocal failure domains are simulated; deploy across separate hosts for machine-failure tolerance.\n',
)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop)
