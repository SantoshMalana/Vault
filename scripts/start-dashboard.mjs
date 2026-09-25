import { cp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
await cp(join(root, '.next', 'static'), join(root, '.next', 'standalone', '.next', 'static'), {
  recursive: true,
})
await cp(join(root, 'public'), join(root, '.next', 'standalone', 'public'), { recursive: true })
process.env.HOSTNAME = process.env.VAULT_DASHBOARD_HOST || '127.0.0.1'
await import(pathToFileURL(join(root, '.next', 'standalone', 'server.js')).href)
