import { NextResponse } from 'next/server'
import { createRelaySession } from '@/lib/relay-session'

export async function GET(request: Request) {
  const session = createRelaySession()
  const response = NextResponse.json({ ok: true })
  const forwardedProtocol = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const protocol = forwardedProtocol ?? new URL(request.url).protocol
  response.cookies.set('relay_session', session, {
    httpOnly: true,
    secure: protocol === 'https:',
    sameSite: 'strict',
    maxAge: 60 * 60,
    path: '/',
  })
  return response
}
