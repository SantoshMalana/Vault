import { NextRequest, NextResponse } from 'next/server'
import {
  sameOrigin,
  secureCookie,
  loginSource,
  LoginLimiter,
  readLoginToken,
  SessionBodyError,
} from '@/services/dashboard-security.mjs'

export const runtime = 'nodejs'
const gateway = () => process.env.VAULT_GATEWAY_URL || 'http://127.0.0.1:7400'
const attempts = new LoginLimiter()

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 })
  const limit = attempts.take(loginSource(req))
  if (!limit.allowed)
    return NextResponse.json(
      { error: 'Too many attempts. Try again shortly.' },
      {
        status: 429,
        headers: { 'retry-after': String(limit.retryAfter) },
      },
    )
  try {
    const token = await readLoginToken(req)
    const result = await fetch(`${gateway()}/v1/cluster`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    })
    await result.body?.cancel()
    if (!result.ok)
      return NextResponse.json(
        { error: result.status === 401 ? 'Access token not recognized.' : 'The cluster is unavailable.' },
        { status: result.status },
      )
    const response = NextResponse.json({ ok: true })
    response.cookies.set('vault_session', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookie(req),
      path: '/',
      maxAge: 8 * 60 * 60,
    })
    return response
  } catch (error) {
    if (error instanceof SessionBodyError)
      return NextResponse.json({ error: error.message }, { status: error.status })
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
