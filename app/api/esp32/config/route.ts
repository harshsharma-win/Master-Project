import { NextResponse } from 'next/server'
import { configureBroker, getBrokerConfig, type BrokerConfig } from '@/lib/esp32-mqtt'
import { isRelaySessionValid } from '@/lib/relay-session'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  if (!isRelaySessionValid(request)) {
    return NextResponse.json({ ok: false, error: 'Dashboard session required.' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, config: getBrokerConfig() }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  if (!isRelaySessionValid(request)) {
    return NextResponse.json({ ok: false, error: 'Dashboard session required.' }, { status: 401 })
  }

  let body: Partial<BrokerConfig>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 })
  }

  const server = String(body.server ?? '').trim()
  const port = Number(body.port)
  const username = String(body.username ?? '').trim()
  const password = String(body.password ?? '')
  const commandTopic = String(body.commandTopic ?? '').trim()
  const statusTopic = String(body.statusTopic ?? '').trim()
  const ackTopic = String(body.ackTopic ?? '').trim()

  if (!server || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !commandTopic || !statusTopic || !ackTopic ||
      commandTopic.includes('+') || commandTopic.includes('#') ||
      statusTopic.includes('+') || statusTopic.includes('#') ||
      ackTopic.includes('+') || ackTopic.includes('#')) {
    return NextResponse.json({ ok: false, error: 'Enter a valid broker, port, and MQTT topic names.' }, { status: 400 })
  }

  configureBroker({ server, port, username, password, commandTopic, statusTopic, ackTopic })
  return NextResponse.json({ ok: true, config: getBrokerConfig() })
}
