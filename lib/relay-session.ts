import { createHmac, timingSafeEqual } from 'crypto'
import { randomBytes } from 'crypto'

const COOKIE_NAME = 'relay_session'
const runtimeState = globalThis as typeof globalThis & { __relaySessionSecret?: Buffer }

function secret() {
  if (process.env.RELAY_ADMIN_SECRET && process.env.RELAY_ADMIN_SECRET.length >= 32) return process.env.RELAY_ADMIN_SECRET
  if (process.env.NODE_ENV === 'production') {
    throw new Error('RELAY_ADMIN_SECRET must be configured for production sessions.')
  }
  if (!runtimeState.__relaySessionSecret) runtimeState.__relaySessionSecret = randomBytes(32)
  return runtimeState.__relaySessionSecret.toString('hex')
}

export function createRelaySession() {
  const key = secret()
  const expiresAt = Date.now() + 60 * 60 * 1000
  const signature = createHmac('sha256', key).update(String(expiresAt)).digest('hex')
  return `${expiresAt}.${signature}`
}

export function isRelaySessionValid(request: Request) {
  const key = secret()
  if (!key) return false

  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`))
  if (!match) return false

  const [expiresText, signature] = decodeURIComponent(match[1]).split('.')
  const expiresAt = Number(expiresText)
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() || !signature) return false

  const expected = createHmac('sha256', key).update(expiresText).digest()
  const provided = Buffer.from(signature, 'hex')
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}
