import { NextRequest, NextResponse } from 'next/server'
import { sameOrigin } from '@/services/dashboard-security.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function forward(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const token = req.cookies.get('vault_session')?.value
  if (!token) return NextResponse.json({ error: 'Sign in to your cluster.' }, { status: 401 })
  if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
    return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  }
  const { path } = await params
  const url = `${process.env.VAULT_GATEWAY_URL || 'http://127.0.0.1:7400'}/v1/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`
  const headers = new Headers({ authorization: `Bearer ${token}` })
  for (const name of [
    'content-type',
    'content-length',
    'range',
    'if-match',
    'if-none-match',
    'idempotency-key',
    'x-content-sha256',
  ]) {
    const value = req.headers.get(name)
    if (value) headers.set(name, value)
  }
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: req.method,
      headers,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(180000)]),
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.body) {
      init.body = req.body
      init.duplex = 'half'
    }
    const response = await fetch(url, init)
    const output = new Headers()
    for (const name of [
      'content-type',
      'content-length',
      'content-disposition',
      'content-range',
      'etag',
      'x-content-sha256',
      'x-vault-version',
      'x-vault-served-by',
      'accept-ranges',
      'cache-control',
    ]) {
      const value = response.headers.get(name)
      if (value) output.set(name, value)
    }
    output.set('x-content-type-options', 'nosniff')
    return new NextResponse(req.method === 'HEAD' ? null : response.body, {
      status: response.status,
      headers: output,
    })
  } catch {
    return NextResponse.json(
      { error: 'The gateway is unavailable or the request exceeded its deadline.' },
      { status: 503 },
    )
  }
}
export { forward as GET, forward as HEAD, forward as PUT, forward as POST, forward as DELETE }
