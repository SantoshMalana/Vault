import { NextResponse } from 'next/server'
import { getCluster, resetCluster } from '@/lib/vault/cluster'
import { errorResponse, num, str } from '@/lib/vault/http'
import type { Tunables, WorkloadState } from '@/lib/vault/types'
import { VaultError } from '@/lib/vault/util'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = Record<string, unknown> & { action?: string }

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body
    const action = str(body.action, 'action')
    const cluster = getCluster()

    switch (action) {
      case 'kill':
        cluster.kill(str(body.node, 'node'))
        break
      case 'revive':
        cluster.revive(str(body.node, 'node'))
        break
      case 'wipe':
        cluster.wipe(str(body.node, 'node'))
        break
      case 'corrupt': {
        const hit = cluster.corrupt(
          str(body.node, 'node'),
          Math.max(1, Math.min(50, Math.floor(num(body.count, 1)))),
          typeof body.objectId === 'string' ? body.objectId : undefined,
        )
        return NextResponse.json({ ok: true, corrupted: hit })
      }
      case 'slow':
        cluster.setSlow(str(body.node, 'node'), num(body.ms, 0))
        break
      case 'skew':
        cluster.setSkew(str(body.node, 'node'), num(body.ms, 0))
        break
      case 'partition': {
        if (!Array.isArray(body.groups) || !body.groups.every((g) => Array.isArray(g) && g.every((x) => typeof x === 'string'))) {
          throw new VaultError('groups must be an array of string arrays', 400)
        }
        cluster.partition(body.groups as string[][])
        break
      }
      case 'heal':
        cluster.heal()
        break
      case 'add-node': {
        const id = await cluster.addNode()
        return NextResponse.json({ ok: true, node: id })
      }
      case 'decommission':
        await cluster.decommission(str(body.node, 'node'))
        break
      case 'set-bucket':
        await cluster.setBucket({
          name: str(body.name, 'name'),
          n: num(body.n, 3),
          w: num(body.w, 2),
          r: num(body.r, 2),
          sloppy: body.sloppy === true,
        })
        break
      case 'delete-bucket':
        await cluster.deleteBucket(str(body.name, 'name'))
        break
      case 'tunables':
        cluster.setTunables((body.patch ?? {}) as Partial<Tunables>)
        break
      case 'workload':
        cluster.setWorkload((body.patch ?? {}) as Partial<WorkloadState>)
        break
      case 'scenario-start':
        cluster.scenario.start((body.options ?? {}) as Record<string, number>)
        break
      case 'scenario-cancel':
        cluster.scenario.cancel()
        break
      case 'reset':
        resetCluster()
        break
      default:
        throw new VaultError(`unknown action "${action}"`, 400)
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
