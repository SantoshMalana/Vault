import { NextResponse } from 'next/server'
import { getCluster } from '@/lib/vault/cluster'
import { deleteObject, getObject, MAX_OBJECT_BYTES, putObject } from '@/lib/vault/coordinator'
import { errorResponse } from '@/lib/vault/http'
import type { Consistency } from '@/lib/vault/types'
import { VaultError, versionToString } from '@/lib/vault/util'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ bucket: string; key: string[] }> }

async function resolve(params: Params['params']) {
  const { bucket, key } = await params
  return { bucket, key: key.map(decodeURIComponent).join('/') }
}

function coordinatorFrom(req: Request) {
  return req.headers.get('x-vault-coordinator') ?? new URL(req.url).searchParams.get('coordinator') ?? undefined
}

export async function PUT(req: Request, { params }: Params) {
  try {
    const { bucket, key } = await resolve(params)
    const length = Number(req.headers.get('content-length') ?? 0)
    if (length > MAX_OBJECT_BYTES) throw new VaultError('object exceeds 8 MB limit', 413)
    const data = Buffer.from(await req.arrayBuffer())
    const result = await putObject(getCluster(), {
      bucket,
      key,
      data,
      contentType: req.headers.get('content-type') ?? undefined,
      coordinator: coordinatorFrom(req),
    })
    return NextResponse.json(result, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(req: Request, { params }: Params) {
  try {
    const { bucket, key } = await resolve(params)
    const url = new URL(req.url)
    const consistency = (url.searchParams.get('consistency') ?? 'quorum') as Consistency
    if (!['one', 'quorum', 'all'].includes(consistency)) throw new VaultError('consistency must be one|quorum|all', 400)
    const res = await getObject(getCluster(), bucket, key, { consistency, coordinator: coordinatorFrom(req) })
    const trace = {
      version: versionToString(res.manifest.version),
      coordinator: res.coordinator,
      r: res.r,
      servedBy: res.servedBy,
      staleReplicas: res.staleReplicas,
      corruptReplicas: res.corruptReplicas,
      latencyMs: res.latencyMs,
      size: res.manifest.size,
      chunks: res.manifest.chunks.length,
      sha256: res.manifest.sha256,
      contentType: res.manifest.contentType,
    }
    if (url.searchParams.get('meta') === '1') {
      const isText = /^text\/|json|xml|javascript/.test(res.manifest.contentType)
      return NextResponse.json({
        ...trace,
        preview: isText ? res.data.subarray(0, 4096).toString('utf8') : null,
      })
    }
    return new NextResponse(new Uint8Array(res.data), {
      headers: {
        'Content-Type': res.manifest.contentType,
        'Content-Length': String(res.data.length),
        ETag: `"${res.manifest.sha256}"`,
        'x-vault-version': trace.version,
        'x-vault-coordinator': trace.coordinator,
        'x-vault-served-by': trace.servedBy.join(','),
        'x-vault-stale': trace.staleReplicas.join(','),
        'x-vault-corrupt': trace.corruptReplicas.join(','),
        'Content-Disposition': `inline; filename="${encodeURIComponent(key.split('/').pop() ?? 'object')}"`,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { bucket, key } = await resolve(params)
    const result = await deleteObject(getCluster(), bucket, key, coordinatorFrom(req))
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err)
  }
}
