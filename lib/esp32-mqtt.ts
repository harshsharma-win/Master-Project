import mqtt from 'mqtt'

export type BrokerConfig = {
  server: string
  port: number
  username: string
  password: string
  commandTopic: string
  statusTopic: string
  ackTopic: string
}

const defaultConfig: BrokerConfig = {
  server: process.env.MQTT_SERVER ?? 'o7671639.ala.us-east-1.emqxsl.com',
  port: Number(process.env.MQTT_PORT ?? 8883),
  username: process.env.MQTT_USER ?? '',
  password: process.env.MQTT_PASSWORD ?? '',
  commandTopic: process.env.MQTT_COMMAND_TOPIC ?? 'thefool/device01/cmd',
  statusTopic: process.env.MQTT_STATUS_TOPIC ?? 'thefool/device01/status/json',
  ackTopic: process.env.MQTT_ACK_TOPIC ?? 'thefool/device01/ack',
}

export const latestStatus: {
  online: boolean
  state: string
  device?: string
  rssi?: number
  updatedAt: string
} = {
  online: false,
  state: 'offline',
  updatedAt: new Date(0).toISOString(),
}

export const latestAck: {
  signal: string
  status: string
  updatedAt: string
} = {
  signal: '',
  status: '',
  updatedAt: new Date(0).toISOString(),
}

type SharedMqttState = {
  client?: mqtt.MqttClient
  config?: BrokerConfig
}

const state = globalThis as typeof globalThis & { __relayMqtt?: SharedMqttState }
if (!state.__relayMqtt) state.__relayMqtt = {}

export function getBrokerClient() {
  if (!state.__relayMqtt) return null
  const config = state.__relayMqtt.config ?? defaultConfig
  if (state.__relayMqtt.client?.connected) return state.__relayMqtt.client

  const mqttUrl = config.server.startsWith('mqtt') ? config.server : `mqtts://${config.server}:${config.port}`
  const client = mqtt.connect(mqttUrl, {
    ...(config.username && config.password ? { username: config.username, password: config.password } : {}),
    clientId: `relay-api-${crypto.randomUUID()}`,
    rejectUnauthorized: true,
    connectTimeout: 8_000,
    reconnectPeriod: 3_000,
    keepalive: 30,
  })

  client.on('connect', () => {
    client.subscribe([config.statusTopic, config.ackTopic], { qos: 1 })
  })

  client.on('message', (topic, payload) => {
    if (topic === config.statusTopic) {
      try {
        const data = JSON.parse(payload.toString())
        latestStatus.online = data.online === true && data.state === 'online'
        latestStatus.state = data.state ?? 'offline'
        latestStatus.device = data.device
        latestStatus.rssi = typeof data.rssi === 'number' ? data.rssi : undefined
        latestStatus.updatedAt = new Date().toISOString()
      } catch {
        // Ignore malformed broker payloads.
      }
    }

    if (topic === config.ackTopic) {
      try {
        const data = JSON.parse(payload.toString())
        latestAck.signal = data.signal ?? ''
        latestAck.status = data.status ?? ''
        latestAck.updatedAt = new Date().toISOString()
      } catch {
        // Ignore malformed acknowledgement payloads.
      }
    }
  })

  client.on('error', () => {
    latestStatus.online = false
    latestStatus.state = 'connecting'
  })

  state.__relayMqtt.client = client
  return client
}

export function getBrokerConfig() {
  const config = state.__relayMqtt?.config ?? defaultConfig
  return { ...config, password: '' }
}

export function getCommandTopic() {
  return (state.__relayMqtt?.config ?? defaultConfig).commandTopic
}

export function configureBroker(config: BrokerConfig) {
  if (!state.__relayMqtt) state.__relayMqtt = {}
  const oldClient = state.__relayMqtt?.client
  if (oldClient) oldClient.end(true)
  state.__relayMqtt.client = undefined
  state.__relayMqtt.config = { ...config }
  latestStatus.online = false
  latestStatus.state = 'connecting'
  latestStatus.updatedAt = new Date().toISOString()
  return getBrokerClient()
}
