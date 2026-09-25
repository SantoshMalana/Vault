import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const path = resolve(import.meta.dirname, '..', '.env')
await writeFile(
  path,
  `ADMIN_TOKEN=${randomBytes(32).toString('hex')}\nNODE_TOKEN=${randomBytes(32).toString('hex')}\n`,
  { mode: 0o600, flag: 'wx' },
)
console.log(
  'Created .env with fresh secrets. Read ADMIN_TOKEN from that file to sign in. Existing secrets are never overwritten.',
)
