import { NextResponse } from 'next/server'
import { getCluster } from '@/lib/vault/cluster'
import { listObjects } from '@/lib/vault/coordinator'
import { errorResponse } from '@/lib/vault/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ bucket: string }> }) {
  try {
    const { bucket } = await params
    const includeDeleted = new URL(req.url).searchParams.get('deleted') === '1'
    return NextResponse.json(listObjects(getCluster(), bucket, includeDeleted), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
