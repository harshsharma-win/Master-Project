import { NextResponse } from 'next/server'
import { getBrokerClient, getCommandTopic } from '@/lib/esp32-mqtt'
import { isRelaySessionValid } from '@/lib/relay-session'

type CommandBody = {
  signal?: string
  motor?: number
  vibrations?: number
  pulseDuration?: number
  pulseGap?: number
  device?: string
}

function isValidSignal(signal: string) {
  return ['OPTION_1', 'OPTION_2', 'OPTION_3', 'OPTION_4', 'QUICK_MOTOR_2', 'REPEAT_QUESTION', 'REPEAT_OPTION', 'CUSTOM_PATTERN', 'STOP'].includes(signal)
}

export async function POST(request: Request) {
  const origin = request.headers.get('origin')
  if (!isRelaySessionValid(request)) {
    return NextResponse.json({ ok: false, error: 'Dashboard session required.' }, { status: 401 })
  }
  if (origin) {
    const requestUrl = new URL(request.url)
    const originUrl = new URL(origin)
    const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
    const host = forwardedHost ?? request.headers.get('host') ?? requestUrl.host
    const allowedHost = host.split(':')[0]
    if (originUrl.hostname !== allowedHost && originUrl.hostname !== 'localhost' && originUrl.hostname !== '127.0.0.1') {
      return NextResponse.json({ ok: false, error: 'Cross-origin requests are not allowed.' }, { status: 403 })
    }
  }
  let body: CommandBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 })
  }

  const signal = body.signal?.trim() ?? ''
  const motor = body.motor ?? 1
  const vibrations = body.vibrations ?? 1
  const pulseDuration = body.pulseDuration ?? 250
  const pulseGap = body.pulseGap ?? 250

  if (typeof motor !== 'number' || typeof vibrations !== 'number' ||
      typeof pulseDuration !== 'number' || typeof pulseGap !== 'number' ||
      !Number.isInteger(motor) || !Number.isInteger(vibrations) ||
      !Number.isInteger(pulseDuration) || !Number.isInteger(pulseGap)) {
    return NextResponse.json({ ok: false, error: 'Numeric command values must be integers.' }, { status: 400 })
  }

  if (!isValidSignal(signal) || !Number.isInteger(motor) || ![1, 2].includes(motor) ||
      !Number.isInteger(vibrations) || vibrations < 1 || vibrations > 20 ||
      !Number.isInteger(pulseDuration) || pulseDuration < 50 || pulseDuration > 5_000 ||
      !Number.isInteger(pulseGap) || pulseGap < 50 || pulseGap > 5_000) {
    return NextResponse.json({ ok: false, error: 'Invalid ESP32 command.' }, { status: 400 })
  }

  try {
    const client = getBrokerClient()
    if (!client) throw new Error('MQTT client is unavailable.')

    if (!client.connected) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('MQTT broker connection timed out.')), 8_000)
        client.once('connect', () => { clearTimeout(timeout); resolve() })
        client.once('error', (error) => { clearTimeout(timeout); reject(error) })
      })
    }

    const payload = JSON.stringify({ signal, motor, vibrations, pulseDuration, pulseGap, device: body.device ?? 'ESP32-RELAY-01', timestamp: new Date().toISOString() })
    const commandTopic = getCommandTopic()
    await new Promise<void>((resolve, reject) => client.publish(commandTopic, payload, { qos: 1 }, (error) => error ? reject(error) : resolve()))

    return NextResponse.json({ ok: true, topic: commandTopic, command: JSON.parse(payload) })
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'Unable to publish MQTT command.' }, { status: 502 })
  }
}
