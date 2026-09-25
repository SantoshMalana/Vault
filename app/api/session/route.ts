import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
const gateway = () => process.env.VAULT_GATEWAY_URL || 'http://127.0.0.1:7400'
const attempts = new Map<string, { count: number; until: number }>()

function sameOrigin(req: NextRequest) {
  return !req.headers.get('origin') || new URL(req.headers.get('origin')!).host === req.headers.get('host')
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  const source = req.headers.get('x-forwarded-for') || 'local'
  const previous = attempts.get(source)
  if (previous && previous.until > Date.now() && previous.count >= 10)
    return NextResponse.json({ error: 'Too many attempts. Try again in a minute.' }, { status: 429 })
  if (attempts.size > 10000) attempts.clear()
  attempts.set(source, {
    count: previous && previous.until > Date.now() ? previous.count + 1 : 1,
    until: Date.now() + 60000,
  })
  const { token } = await req.json().catch(() => ({}))
  if (typeof token !== 'string' || token.length < 16 || token.length > 1024)
    return NextResponse.json({ error: 'Enter a valid access token.' }, { status: 400 })
  try {
    const result = await fetch(`${gateway()}/v1/cluster`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
    if (!result.ok)
      return NextResponse.json(
        { error: result.status === 401 ? 'Access token not recognized.' : 'The cluster is unavailable.' },
        { status: result.status },
      )
    await result.body?.cancel()
    attempts.delete(source)
    const response = NextResponse.json({ ok: true })
    response.cookies.set('vault_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.VAULT_COOKIE_SECURE === 'true',
      path: '/',
      maxAge: 8 * 60 * 60,
    })
    return response
  } catch {
    return NextResponse.json(
      { error: 'Cannot reach the storage gateway. Start the cluster and retry.' },
      { status: 503 },
    )
  }
}

export async function DELETE(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('vault_session')
  return response
}
