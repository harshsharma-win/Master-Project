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
  autoRepeat?: boolean
  lastAnswer?: string
  brokerError?: string
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
  clientConfigKey?: string
  config?: BrokerConfig
}

const state = globalThis as typeof globalThis & { __relayMqtt?: SharedMqttState }
if (!state.__relayMqtt) state.__relayMqtt = {}

function currentConfig(): BrokerConfig {
  const override = state.__relayMqtt?.config
  return {
    ...defaultConfig,
    ...override,
    server: override?.server || defaultConfig.server,
    port: override?.port ?? defaultConfig.port,
    username: defaultConfig.username || override?.username || '',
    password: defaultConfig.password || override?.password || '',
    commandTopic: override?.commandTopic || defaultConfig.commandTopic,
    statusTopic: override?.statusTopic || defaultConfig.statusTopic,
    ackTopic: override?.ackTopic || defaultConfig.ackTopic,
  }
}

function summarizeBrokerError(error: Error) {
  const message = error.message.toLowerCase()
  if (message.includes('not authorized') || message.includes('bad user') || message.includes('bad password')) return 'The MQTT broker rejected its credentials.'
  if (message.includes('certificate') || message.includes('tls')) return 'MQTT TLS certificate validation failed.'
  if (message.includes('enotfound') || message.includes('eai_again') || message.includes('getaddrinfo')) return 'The MQTT broker hostname could not be resolved.'
  if (message.includes('econnrefused') || message.includes('connection refused')) return 'The MQTT broker refused the connection.'
  if (message.includes('timeout') || message.includes('timed out')) return 'The MQTT broker connection timed out.'
  return 'The MQTT broker connection failed.'
}

export function getBrokerClient() {
  if (!state.__relayMqtt) return null
  const config = currentConfig()
  const configKey = JSON.stringify(config)
  if (state.__relayMqtt.client && state.__relayMqtt.clientConfigKey === configKey && !state.__relayMqtt.client.disconnecting) return state.__relayMqtt.client
  if (state.__relayMqtt.client) state.__relayMqtt.client.end(true)

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
    latestStatus.brokerError = undefined
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
        latestStatus.autoRepeat = typeof data.autoRepeat === 'boolean' ? data.autoRepeat : undefined
        latestStatus.lastAnswer = typeof data.lastAnswer === 'string' ? data.lastAnswer : undefined
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

  client.on('error', (error) => {
    latestStatus.brokerError = summarizeBrokerError(error)
    latestStatus.online = false
    latestStatus.state = 'connecting'
  })

  state.__relayMqtt.clientConfigKey = configKey
  state.__relayMqtt.client = client
  return client
}

export async function refreshBrokerStatus(timeoutMs = 3_500) {
  const client = getBrokerClient()
  if (!client) return latestStatus

  const statusAge = Date.now() - new Date(latestStatus.updatedAt).getTime()
  if (Number.isFinite(statusAge) && statusAge < 10_000 && latestStatus.state !== 'connecting') return latestStatus

  const deadline = Date.now() + timeoutMs
  if (!client.connected) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout)
        client.off('connect', finish)
        client.off('error', finish)
        resolve()
      }
      const timeout = setTimeout(finish, Math.max(0, deadline - Date.now()))
      client.once('connect', finish)
      client.once('error', finish)
      if (client.connected) finish()
    })
  }

  if (!client.connected) return latestStatus

  const config = currentConfig()
  await new Promise<void>((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      client.off('message', onMessage)
      resolve()
    }
    const onMessage = (topic: string) => {
      if (topic === config.statusTopic) finish()
    }
    client.on('message', onMessage)
    timeout = setTimeout(finish, Math.max(0, deadline - Date.now()))
    client.subscribe(config.statusTopic, { qos: 1 }, (error) => {
      if (error) finish()
    })
  })

  return latestStatus
}

export function getBrokerConfig() {
  const config = currentConfig()
  return { ...config, password: '' }
}

export function getCommandTopic() {
  return currentConfig().commandTopic
}

export function configureBroker(config: BrokerConfig) {
  if (!state.__relayMqtt) state.__relayMqtt = {}
  const oldClient = state.__relayMqtt?.client
  if (oldClient) oldClient.end(true)
  state.__relayMqtt.client = undefined
  state.__relayMqtt.clientConfigKey = undefined
  state.__relayMqtt.config = {
    ...defaultConfig,
    ...config,
    username: config.username || defaultConfig.username,
    password: config.password || defaultConfig.password,
  }
  latestStatus.online = false
  latestStatus.state = 'connecting'
  latestStatus.updatedAt = new Date().toISOString()
  return getBrokerClient()
}
