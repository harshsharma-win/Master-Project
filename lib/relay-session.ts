import { createHmac, timingSafeEqual } from 'crypto'
import { randomBytes } from 'crypto'

const COOKIE_NAME = 'relay_session'
const runtimeState = globalThis as typeof globalThis & { __relaySessionSecret?: Buffer }

function secret() {
  const configuredSecret = process.env.RELAY_ADMIN_SECRET
  if (configuredSecret) {
    if (configuredSecret.length < 32) {
      throw new Error('RELAY_ADMIN_SECRET must be at least 32 characters.')
    }
    return configuredSecret
  }

  if (process.env.NODE_ENV === 'production' && process.env.MQTT_PASSWORD) {
    return createHmac('sha256', process.env.MQTT_PASSWORD).update('relay-session-signing-key:v1').digest('hex')
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('A stable server-side session secret or MQTT_PASSWORD must be configured for production sessions.')
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
