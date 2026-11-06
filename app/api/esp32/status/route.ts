import { NextResponse } from 'next/server'
import { getBrokerClient, latestAck, latestStatus } from '@/lib/esp32-mqtt'

export const runtime = 'nodejs'

export async function GET() {
  const client = getBrokerClient()
  const statusAge = latestStatus.updatedAt === new Date(0).toISOString()
    ? Number.POSITIVE_INFINITY
    : Date.now() - new Date(latestStatus.updatedAt).getTime()

  if (statusAge > 45_000 && latestStatus.state !== 'configuration-required') {
    latestStatus.online = false
    latestStatus.state = 'offline'
  }

  return NextResponse.json({
    ok: true,
    brokerConnected: client?.connected === true,
    ...latestStatus,
    acknowledgement: latestAck,
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
