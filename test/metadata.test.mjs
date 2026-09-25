import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMetadata } from '../services/metadata.mjs'
import { placement } from '../services/gateway.mjs'

test('metadata journal atomically commits compares and recovers after a partial final record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-journal-'))
  let store = await new LocalMetadata().init(dir)
  try {
    assert(
      await store.txn(
        [{ key: 'a', revision: 0 }],
        [
          { key: 'a', value: { name: 'résumé' } },
          { key: 'b', value: 2 },
        ],
      ),
    )
    assert.equal(await store.txn([{ key: 'a', revision: 0 }], [{ key: 'a', value: 3 }]), false)
    const results = await Promise.all(
      [3, 4].map((value) => store.txn([{ key: 'b', revision: 1 }], [{ key: 'b', value }])),
    )
    assert.equal(results.filter(Boolean).length, 1)
    await store.close()
    await appendFile(join(dir, 'metadata.wal'), '{"revision":3,"puts":')
    store = await new LocalMetadata().init(dir)
    assert.deepEqual((await store.get('a')).value, { name: 'résumé' })
    assert.equal((await store.get('b')).revision, 2)
    assert(await store.txn([{ key: 'c', revision: 0 }], [{ key: 'c', value: true }]))
    await store.close()
    store = await new LocalMetadata().init(dir)
    assert.equal((await store.get('c')).value, true)
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('placement always uses distinct failure domains and includes successive joining nodes', () => {
  const nodes = Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, domain: `host${i}`, draining: false }))
  const observed = new Set()
  for (let k = 0; k < 200; k++) {
    const owners = placement(nodes, 'default', `key${k}`, 3)
    assert.equal(owners.length, 3)
    assert.equal(new Set(owners.map((n) => n.domain)).size, 3)
    for (const n of owners) observed.add(n.id)
  }
  assert.equal(observed.size, nodes.length)
  nodes[8].domain = nodes[7].domain
  assert.equal(placement(nodes, 'default', 'test', 9).length, 8)
})
