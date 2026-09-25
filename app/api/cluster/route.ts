import { NextResponse } from 'next/server'
import { getCluster } from '@/lib/vault/cluster'
import { errorResponse } from '@/lib/vault/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  try {
    return NextResponse.json(getCluster().snapshot(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    return errorResponse(err)
  }
}
