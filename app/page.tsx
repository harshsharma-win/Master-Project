'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronRight, CircleHelp, Clipboard, Cloud, Cpu, Headphones, Mic, MicOff, MoreHorizontal, Radio, RefreshCw, Send, Settings2, ShieldCheck, Smartphone, Wifi, Zap } from 'lucide-react'
import { supabase, supabaseConfigured } from '@/lib/supabase-client'

const signals = [
  { signal: 'A', label: 'Option 1', detail: '1 vibration', count: 1, tone: 'mint' },
  { signal: 'B', label: 'Option 2', detail: '2 vibrations', count: 2, tone: 'blue' },
  { signal: 'C', label: 'Option 3', detail: '3 vibrations', count: 3, tone: 'violet' },
  { signal: 'D', label: 'Option 4', detail: '4 vibrations', count: 4, tone: 'orange' },
]

type Transcript = { time: string; text: string; tag: 'Live' | 'Sent' | 'Saved' }

function formatSpeech(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  return normalized
    .replace(/\bi\b/g, 'I')
    .replace(/\b(?:option\s+)?([ABCD])\s*[.):]\s*/gi, '\nOption $1:')
}

function parseMcq(text: string) {
  const formatted = formatSpeech(text)
  const optionMatches = [...formatted.matchAll(/Option\s+([ABCD]):\s*(.*?)(?=\nOption\s+[ABCD]:|$)/gi)]
  const firstOption = formatted.search(/Option [ABCD]:/i)
  const question = firstOption >= 0 ? formatted.slice(0, firstOption).replace(/\s+/g, ' ').trim() : formatted
  return {
    question: question.replace(/^question\s*\d*[:.)-]?\s*/i, '').trim(),
    options: optionMatches.map((match) => ({ letter: match[1].toUpperCase(), text: match[2].replace(/\n/g, ' ').trim() })),
  }
}

export default function Page() {
  const [page, setPage] = useState<'dashboard' | 'connect'>('dashboard')
  const [connected, setConnected] = useState(false)
  const [connectionIssue, setConnectionIssue] = useState('')
  const [lastDeviceSeen, setLastDeviceSeen] = useState<Date | null>(null)
  const [selected, setSelected] = useState('B')
  const [lastSignal, setLastSignal] = useState('B')
  const [deviceAck, setDeviceAck] = useState<{ signal: string; status: string; updatedAt: string } | null>(null)
  const [autoRepeatEnabled, setAutoRepeatEnabled] = useState(false)
  const deviceSettingsLoadedRef = useRef(false)
  const lastAckTimeRef = useRef('')
  const [pulses, setPulses] = useState(5)
  const [pulseDuration, setPulseDuration] = useState(250)
  const [pulseGap, setPulseGap] = useState(250)
  const [customMotor, setCustomMotor] = useState<1 | 2>(1)
  const [sending, setSending] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deviceId, setDeviceId] = useState('ESP32-RELAY-01')
  const [endpoint, setEndpoint] = useState('o7671639.ala.us-east-1.emqxsl.com:8883')
  const [transcript, setTranscript] = useState<Transcript[]>([])
  const [listening, setListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const recognitionRef = useRef<any>(null)
  const paragraphRef = useRef('')
  const shouldListenRef = useRef(false)

  useEffect(() => {
    const savedDevice = window.localStorage.getItem('relay-device-id')
    const savedEndpoint = window.localStorage.getItem('relay-endpoint')
    const savedSignal = window.localStorage.getItem('relay-last-signal')
    const savedPattern = window.localStorage.getItem('relay-custom-pattern')
    const savedTranscript = window.localStorage.getItem('relay-transcript')
    if (savedDevice) setDeviceId(savedDevice)
    if (savedEndpoint) setEndpoint(savedEndpoint)
    if (savedSignal && signals.some((item) => item.signal === savedSignal)) { setSelected(savedSignal); setLastSignal(savedSignal) }
    if (savedPattern) {
      try {
        const pattern = JSON.parse(savedPattern)
        const pulses = Number(pattern.pulses)
        const duration = Number(pattern.duration)
        const gap = Number(pattern.gap)
        if (Number.isInteger(pulses) && pulses >= 1 && pulses <= 20) setPulses(pulses)
        if (Number.isInteger(duration) && duration >= 50 && duration <= 5000) setPulseDuration(duration)
        if (Number.isInteger(gap) && gap >= 50 && gap <= 5000) setPulseGap(gap)
        if (pattern.motor === 1 || pattern.motor === 2) setCustomMotor(pattern.motor)
      } catch {
        window.localStorage.removeItem('relay-custom-pattern')
      }
    }
    if (savedTranscript) {
      try {
        const history = JSON.parse(savedTranscript)
        if (Array.isArray(history)) setTranscript(history.slice(0, 20))
      } catch {
        window.localStorage.removeItem('relay-transcript')
      }
    }
    const channel = supabaseConfigured ? supabase.channel('esp32-relay-control')
      .on('broadcast', { event: 'device_status' }, ({ payload }) => {
        const matchesDevice = !payload?.device || payload.device === savedDevice || payload.device === deviceId
        if (matchesDevice && payload?.online !== false) {
          setConnected(true)
          setLastDeviceSeen(new Date())
        } else if (matchesDevice) {
          setConnected(false)
        }
      })
      .on('broadcast', { event: 'transcript' }, ({ payload }) => {
        if (payload?.text) setTranscript((items) => [{ time: new Date().toLocaleTimeString([], { hour12: false }), text: payload.text, tag: 'Live' as const }, ...items].slice(0, 10))
      })
      .subscribe()
      : null
    return () => { if (channel) void supabase.removeChannel(channel) }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('relay-custom-pattern', JSON.stringify({
      pulses,
      duration: pulseDuration,
      gap: pulseGap,
      motor: customMotor,
    }))
  }, [pulses, pulseDuration, pulseGap, customMotor])

  useEffect(() => {
    window.localStorage.setItem('relay-transcript', JSON.stringify(transcript.slice(0, 20)))
  }, [transcript])

  useEffect(() => {
    let cancelled = false

    async function refreshConnection() {
      try {
        const response = await fetch('/api/esp32/status', { cache: 'no-store' })
        if (!response.ok) throw new Error('Connection status unavailable')
        const status = await response.json()
        if (cancelled) return
        setConnected(status.online === true)
        setConnectionIssue(status.brokerConnected === true
          ? status.online === true ? '' : 'Broker reachable, but no fresh ESP32 heartbeat. Check device Wi-Fi, MQTT topics, and secrets.h.'
          : 'MQTT broker unavailable. Configure MQTT_USER and MQTT_PASSWORD in project variables.')
        if (status.online === true) setLastDeviceSeen(new Date(status.updatedAt || Date.now()))
        if (typeof status.autoRepeat === 'boolean' && !deviceSettingsLoadedRef.current) {
          setAutoRepeatEnabled(status.autoRepeat)
          deviceSettingsLoadedRef.current = true
        }
        if (typeof status.lastAnswer === 'string' && /^[A-D]$/.test(status.lastAnswer)) {
          setLastSignal(status.lastAnswer)
          setSelected(status.lastAnswer)
        }
        const ack = status.acknowledgement
        if (ack?.signal && ack?.status && ack.updatedAt && ack.updatedAt !== lastAckTimeRef.current) {
          lastAckTimeRef.current = ack.updatedAt
          setDeviceAck({ signal: ack.signal, status: ack.status, updatedAt: ack.updatedAt })
        }
      } catch {
        if (!cancelled) {
          setConnected(false)
          setConnectionIssue('Unable to read device status from the dashboard server.')
        }
      }
    }

    void refreshConnection()
    const interval = window.setInterval(refreshConnection, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (lastDeviceSeen && Date.now() - lastDeviceSeen.getTime() > 45_000) setConnected(false)
    }, 5_000)
    return () => window.clearInterval(interval)
  }, [lastDeviceSeen])

  function sendSignal(signal: (typeof signals)[number], motor = 1) {
    if (sending) return
    setSelected(signal.signal); setLastSignal(signal.signal)
    window.localStorage.setItem('relay-last-signal', signal.signal)
    setTranscript((items) => [{ time: new Date().toLocaleTimeString([], { hour12: false }), text: `Signal ${signal.signal} sent — ${signal.label}.`, tag: 'Sent' }, ...items])
    void publishCommand({ signal: signal.signal === 'A' ? 'OPTION_1' : signal.signal === 'B' ? 'OPTION_2' : signal.signal === 'C' ? 'OPTION_3' : 'OPTION_4', motor, vibrations: signal.count, device: deviceId })
  }

  function toggleAutoRepeat() {
    if (!connected || sending) return
    const enabled = !autoRepeatEnabled
    setAutoRepeatEnabled(enabled)
    deviceSettingsLoadedRef.current = true
    addAction(enabled ? 'Auto-repeat enabled: the ESP32 button will repeat the last A/B/C/D answer after 2 seconds.' : 'Auto-repeat disabled on the ESP32.')
    void publishCommand({ signal: 'SET_AUTO_REPEAT', enabled, device: deviceId })
  }

  function sendMotorCommand(signal: 'QUICK_MOTOR_2' | 'REPEAT_QUESTION' | 'REPEAT_OPTION' | 'STOP' | 'CUSTOM_PATTERN', motor: number, vibrations: number, text: string, duration = 250, gap = 250) {
    if (sending) return
    addAction(text)
    void publishCommand({ signal, motor, vibrations, pulseDuration: duration, pulseGap: gap, device: deviceId })
  }

  async function publishCommand(payload: Record<string, unknown>) {
    setSending(true)
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 12_000)
    try {
      const sessionResponse = await fetch('/api/esp32/session', { credentials: 'same-origin' })
      if (!sessionResponse.ok) throw new Error('Dashboard session could not be created')
      const response = await fetch('/api/esp32/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: 'same-origin',
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'MQTT command failed')
      addAction('Command sent successfully.')
    } catch (error) {
      addAction(`Command not sent: ${error instanceof Error && error.name !== 'AbortError' ? error.message : 'Connection timed out'}`)
    } finally {
      window.clearTimeout(timeout)
      window.setTimeout(() => setSending(false), 350)
    }
  }

  function addAction(text: string) {
    setTranscript((items) => [{ time: new Date().toLocaleTimeString([], { hour12: false }), text, tag: 'Sent' }, ...items])
  }

  function toggleMicrophone() {
    if (listening) {
      shouldListenRef.current = false
      recognitionRef.current?.stop()
      setListening(false)
      setInterimText('')
      if (paragraphRef.current.trim()) {
        const text = paragraphRef.current.trim()
        setTranscript((items) => [{ time: new Date().toLocaleTimeString([], { hour12: false }), text, tag: 'Saved' as const }, ...items].slice(0, 10))
        paragraphRef.current = ''
      }
      return
    }
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      addAction('Live transcript is not supported in this browser.')
      return
    }
    paragraphRef.current = ''
    setInterimText('')
    shouldListenRef.current = true
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = 'en-US'
    recognition.onresult = (event: any) => {
      let interim = ''
      let finalText = ''
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const phrase = event.results[index]?.[0]?.transcript?.trim() ?? ''
        if (event.results[index].isFinal) finalText += `${phrase} `
        else interim += `${phrase} `
      }
      setInterimText(interim.trim())
      const chunk = finalText.trim().replace(/\s+/g, ' ')
      if (!chunk) return
      const combined = `${paragraphRef.current} ${chunk}`.trim().replace(/\s+/g, ' ')
      const completedSentences = combined.match(/[^.!?]+[.!?]+/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? []
      const completedText = completedSentences.join(' ')
      paragraphRef.current = combined.slice(completedText.length).trim()
      if (completedSentences.length) {
        const timestamp = new Date().toLocaleTimeString([], { hour12: false })
        setTranscript((items) => [...completedSentences.map((sentence) => ({ time: timestamp, text: formatSpeech(sentence), tag: 'Live' as const })), ...items].slice(0, 20))
        if (supabaseConfigured) void supabase.channel('esp32-relay-control').send({ type: 'broadcast', event: 'transcript', payload: { text: completedText } })
      }
    }

    recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        shouldListenRef.current = false
        const messages: Record<string, string> = {
          'audio-capture': 'No microphone was found. Check your input device.',
          'not-allowed': 'Microphone permission was denied. Allow it in browser settings.',
          'network': 'Speech recognition could not reach its provider. Check your internet connection.',
          'service-not-allowed': 'Speech recognition is blocked for this browser or site.',
        }
        addAction(messages[event.error] ?? 'Speech recognition stopped unexpectedly.')
      }
      setListening(Boolean(shouldListenRef.current))
      if (!shouldListenRef.current) setInterimText('')
    }
    recognition.onend = () => {
      if (shouldListenRef.current) {
        window.setTimeout(() => {
          if (shouldListenRef.current && recognitionRef.current === recognition) {
            try { recognition.start() } catch { /* Recognition is already restarting. */ }
          }
        }, 250)
      } else {
        setListening(false)
        setInterimText('')
      }
    }
    recognitionRef.current = recognition
    recognition.start()
    setListening(true)
  }

  function copyTranscript() {
    const text = [paragraphRef.current, ...transcript.map((item) => item.text)].filter(Boolean).join('\n')
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_200)
    })
  }

  return <main className="app-shell">
    <style>{`
      @media (max-width: 820px) {
        .dashboard-grid.control-layout > .mic-panel {
          grid-column: 1 !important;
          grid-row: 1 !important;
        }
        .dashboard-grid.control-layout > .signal-panel {
          grid-column: 1 !important;
          grid-row: 2 !important;
        }
        .dashboard-grid.control-layout > .lower-grid {
          grid-column: 1 !important;
          grid-row: 3 !important;
        }
      }
    `}</style>
    <aside className="sidebar">
      <div className="brand-mark"><Radio size={19} /></div><div className="brand-copy"><strong>Relay</strong><span>Voice control</span></div>
      <div className="nav-group"><button className={`nav-item ${page === 'dashboard' ? 'active' : ''}`} onClick={() => setPage('dashboard')}><Radio size={17} /> Dashboard</button><button className={`nav-item ${page === 'connect' ? 'active' : ''}`} onClick={() => setPage('connect')}><Wifi size={17} /> Connections</button></div>
      <div className="sidebar-spacer" /><div className={`device-mini ${connected ? '' : 'is-offline'}`}><div className="device-icon"><Cpu size={17} /></div><div><strong>ESP32 relay</strong><span><i className="status-dot" /> {connected ? 'Online' : 'Waiting for device'}</span></div><MoreHorizontal size={16} /></div><button className="settings-link" onClick={() => setPage('connect')}><Settings2 size={17} /> Settings</button><div className="profile"><div className="avatar">HS</div><div><strong>Harsh Sharma</strong><span>Personal workspace</span></div><ChevronRight size={15} /></div>
    </aside>
    <section className="content">
      <header className="topbar"><div><p className="eyebrow">{new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase()}</p><h1>{page === 'dashboard' ? 'Good morning, Harsh' : 'Connection center'}</h1></div><div className="top-actions"><div className={`connection-pill ${connected ? '' : 'offline'}`} role="status" aria-live="polite"><i className="status-dot" /> {connected ? 'ESP32 connected' : 'Waiting for ESP32'}</div><button className="icon-button" aria-label="Open settings" onClick={() => setPage('connect')}><Settings2 size={18} /></button></div></header>
      {page === 'connect' ? <ConnectionPage connected={connected} connectionIssue={connectionIssue} setConnected={setConnected} deviceId={deviceId} setDeviceId={setDeviceId} endpoint={endpoint} setEndpoint={setEndpoint} onDashboard={() => setPage('dashboard')} /> : <>
        <section className={`status-banner ${connected ? '' : 'offline-banner'}`}><div className="status-icon"><ShieldCheck size={20} /></div><div><strong>{connected ? 'ESP32 control is ready' : 'ESP32 is not reporting online'}</strong><span>{connected ? 'Send vibration patterns over the internet. No shared Wi-Fi or LAN required.' : (connectionIssue || 'Check device power and internet access, then wait for its heartbeat.')}</span></div><button className="text-button" onClick={() => setPage('connect')}>Review connection <ChevronRight size={15} /></button></section>
        <div className="dashboard-grid control-layout"><section className="panel mic-panel"><div className="panel-heading"><div><p className="section-label">VOICE INPUT</p><h2>Phone microphone</h2></div><span className="live-badge"><span className="pulse-dot" /> {listening ? 'Listening' : 'Ready'}</span></div><div className="mic-stage"><div className={`mic-orb ${listening ? 'is-listening' : ''}`}><Mic size={34} /></div><div className="waveform">{[22,42,31,58,38,74,45,28,65,44,30,52,35,67,43].map((height, index) => <span key={index} style={{ height: `${listening ? height : 9}px` }} />)}</div><strong>{listening ? 'Listening for speech…' : 'Microphone is ready'}</strong><span className="muted">{listening ? 'Speech stays visible until you stop' : 'Tap start to capture your voice'}</span></div><button className="listen-button" onClick={toggleMicrophone}>{listening ? <><MicOff size={17} /> Stop listening</> : <><Mic size={17} /> Start listening</>}</button></section><section className="panel signal-panel"><div className="panel-heading"><div><p className="section-label">REMOTE OUTPUT</p><h2>Vibration options</h2></div><span className={`relay-status ${connected ? '' : 'offline-status'}`}><i className="status-dot" /> {connected ? 'ESP32 online' : 'ESP32 offline'}</span></div><p className="panel-description">A/B/C/D send a clear vibration response through the internet.</p><div className="signal-grid">{signals.map((signal) => <button key={signal.signal} className={`signal-card ${signal.tone} ${selected === signal.signal ? 'selected' : ''}`} onClick={() => sendSignal(signal)}><div className="signal-letter">{signal.signal}</div><div className="signal-copy"><strong>{signal.label}</strong><span>{signal.detail}</span></div><Send size={16} /></button>)}</div><div className="last-signal"><span>Last command</span><strong>Signal {lastSignal}</strong><span className="last-time">just now</span></div></section></div>
        <div className="lower-grid"><section className="panel transcript-panel transcript-workspace"><div className="panel-heading"><div><p className="section-label">LIVE MCQ TRANSCRIPT</p><h2>Question workspace</h2></div><div className="transcript-actions"><button className="small-action" onClick={copyTranscript}><Clipboard size={14} /> {copied ? 'Copied' : 'Copy'}</button><button className="small-action" onClick={() => setTranscript([])}><RefreshCw size={14} /> Clear</button></div></div><div className="transcript-live-bar"><i className={listening ? 'pulse-dot' : 'status-dot'} />{listening ? 'Listening live' : 'Transcript ready'}<span>{transcript.length} saved segment{transcript.length === 1 ? '' : 's'}</span></div><div className="transcript-content">{(listening || interimText || paragraphRef.current) && <div className="live-transcript"><div className="live-caption"><span>Now speaking</span><strong>{interimText ? 'Live words' : 'Ready'}</strong></div><p>{paragraphRef.current}{paragraphRef.current && interimText ? ' ' : ''}<span>{interimText}</span></p></div>}{transcript.length ? transcript.map((item, index) => { const mcq = parseMcq(item.text); return <article className="question-card" key={`${item.time}-${index}`}><div className="question-card-meta"><span>{index === transcript.length - 1 ? 'Latest question' : `Segment ${transcript.length - index}`}</span><time>{item.time}</time></div><h3>{mcq.question || item.text}</h3>{mcq.options.length > 0 && <div className="option-list">{mcq.options.map((option) => <div className="transcript-option" key={option.letter}><span>{option.letter}</span><p>{option.text || 'Listening…'}</p></div>)}</div>}</article> }) : !listening && !interimText && <div className="transcript-empty"><Mic size={24} /><strong>Start speaking your question</strong><span>Say “Question”, followed by options A through D. The transcript will stay visible.</span></div>}</div></section><section className="panel urgent-panel"><div className="panel-heading"><div><p className="section-label">URGENT CONTROLS</p><h2>Separate actions</h2></div><AlertTriangle size={18} className="orange-icon" /></div><button className="urgent-action" onClick={() => sendMotorCommand('QUICK_MOTOR_2', 2, 4, 'Urgent vibration alert sent to motor 2')}><div className="urgent-icon"><Zap size={18} /></div><div><strong>Send alert</strong><span>Trigger an urgent vibration on motor 2</span></div><ChevronRight size={17} /></button><button className="secondary-action" onClick={() => sendMotorCommand('REPEAT_QUESTION', 2, 2, 'Repeat question sent to motor 2 — 2 vibrations')}><CircleHelp size={17} /><span><strong>Repeat question</strong><small>Ask the speaker to repeat the question</small></span><ChevronRight size={17} /></button><button className="secondary-action" onClick={() => sendSignal(signals[1], 2)}><Headphones size={17} /><span><strong>Quick response · motor 2</strong><small>Send Option 2 · 2 vibrations</small></span><ChevronRight size={17} /></button><div className="auto-repeat-control"><div><strong>Repeat the answer</strong><small>After the ESP32 button is pressed, repeat the last A/B/C/D answer after 2 seconds.</small></div><button type="button" role="switch" aria-checked={autoRepeatEnabled} aria-label="Automatically repeat the last answer after the ESP32 button is pressed" className={`auto-repeat-switch ${autoRepeatEnabled ? 'is-on' : ''}`} disabled={!connected || sending} onClick={toggleAutoRepeat}><span /></button></div><button className="secondary-action" onClick={() => sendMotorCommand('REPEAT_OPTION', 2, 1, 'Repeat answer requested from the ESP32')}><RefreshCw size={17} /><span><strong>Repeat answer now</strong><small>Repeat the most recently selected A/B/C/D answer</small></span><ChevronRight size={17} /></button><div className="device-response" role="status" aria-live="polite"><span>DEVICE RESPONSE</span><strong>{deviceAck ? `${deviceAck.signal === 'REPEAT_OPTION' ? 'Repeat answer' : deviceAck.signal === 'REPEAT_QUESTION' ? 'Repeat question' : deviceAck.signal.replaceAll('_', ' ')} · ${deviceAck.status === 'EXECUTED' ? 'Completed' : deviceAck.status === 'RECEIVED' ? 'Received by device' : deviceAck.status}` : 'Waiting for device confirmation'}</strong><small>{deviceAck ? `Updated ${new Date(deviceAck.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Device acknowledgments will appear here'}</small></div><div className="custom-pattern-editor"><div className="custom-pattern-title"><span>Custom vibration pattern</span><div className="motor-toggle"><button className={customMotor === 1 ? 'active' : ''} onClick={() => setCustomMotor(1)}>Motor 1</button><button className={customMotor === 2 ? 'active' : ''} onClick={() => setCustomMotor(2)}>Motor 2</button></div></div><div className="pattern-controls"><label><span>Vibrations</span><div><button onClick={() => setPulses(Math.max(1, pulses - 1))}>−</button><strong>{pulses}</strong><button onClick={() => setPulses(Math.min(20, pulses + 1))}>+</button></div></label><label><span>Pulse on (ms)</span><input type="number" min="50" max="5000" step="50" value={pulseDuration} onChange={(event) => setPulseDuration(Math.min(5000, Math.max(50, Number(event.target.value) || 50)))} /></label><label><span>Gap off (ms)</span><input type="number" min="50" max="5000" step="50" value={pulseGap} onChange={(event) => setPulseGap(Math.min(5000, Math.max(50, Number(event.target.value) || 50)))} /></label></div><button className="listen-button pattern-send" onClick={() => sendMotorCommand('CUSTOM_PATTERN', customMotor, pulses, `Custom pattern sent — motor ${customMotor}, ${pulses} pulses, ${pulseDuration} ms on, ${pulseGap} ms gap`, pulseDuration, pulseGap)}><Zap size={16} /> Send custom pattern</button></div></section></div>
      </>}
      <footer className="footer-note"><span>Internet encrypted · No LAN required</span><span>Relay v1.0.4</span></footer>
    </section>
  </main>
}

function ConnectionPage({ connected, connectionIssue, setConnected, deviceId, setDeviceId, endpoint, setEndpoint, onDashboard }: { connected: boolean; connectionIssue: string; setConnected: (value: boolean) => void; deviceId: string; setDeviceId: (value: string) => void; endpoint: string; setEndpoint: (value: string) => void; onDashboard: () => void }) {
  const [saved, setSaved] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [brokerPort, setBrokerPort] = useState('8883')
  const [mqttUser, setMqttUser] = useState('')
  const [mqttPassword, setMqttPassword] = useState('')
  const [commandTopic, setCommandTopic] = useState('thefool/device01/cmd')
  const [statusTopic, setStatusTopic] = useState('thefool/device01/status/json')
  const [ackTopic, setAckTopic] = useState('thefool/device01/ack')
  const [connectionMessage, setConnectionMessage] = useState('')
  const [dashboardAddress, setDashboardAddress] = useState('localhost:3000')

  async function saveConnection(configOverride?: Record<string, unknown>) {
    const cleanDeviceId = deviceId.trim()
    const cleanEndpoint = endpoint.trim()
    if (!cleanDeviceId || !cleanEndpoint) return
    const config = configOverride ?? {
      server: cleanEndpoint.replace(/^(mqtts?|wss?):\/\//i, '').replace(/:\d+$/, ''),
      port: Number(brokerPort),
      username: mqttUser.trim(),
      password: mqttPassword,
      commandTopic,
      statusTopic,
      ackTopic,
    }
    window.localStorage.setItem('relay-device-id', deviceId)
    window.localStorage.setItem('relay-endpoint', endpoint)
    window.localStorage.setItem('relay-broker-config', JSON.stringify({ ...config, password: '' }))
    setConnecting(true)
    setConnectionMessage('Connecting to broker…')
    try {
      await fetch('/api/esp32/session')
      const response = await fetch('/api/esp32/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(config),
        credentials: 'same-origin',
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'Broker connection failed')
      setDeviceId(cleanDeviceId)
      setEndpoint(cleanEndpoint)
      setSaved(true)
      setMqttPassword('')
      setConnectionMessage('Broker settings applied. Waiting for the ESP32 heartbeat.')
      setConnected(false)
      window.setTimeout(() => setSaved(false), 3000)
    } catch (error) {
      setConnectionMessage(error instanceof Error ? error.message : 'Broker connection failed')
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    setDashboardAddress(window.location.host || 'localhost:3000')
    const savedConfig = window.localStorage.getItem('relay-broker-config')
    if (!savedConfig) return
    try {
      const config = JSON.parse(savedConfig) as Record<string, string | number>
      setEndpoint(String(config.server ?? endpoint))
      setBrokerPort(String(config.port ?? 8883))
      setMqttUser(String(config.username ?? ''))
      setMqttPassword('')
      setCommandTopic(String(config.commandTopic ?? commandTopic))
      setStatusTopic(String(config.statusTopic ?? statusTopic))
      setAckTopic(String(config.ackTopic ?? ackTopic))
      window.localStorage.removeItem('relay-broker-config')
    } catch {
      window.localStorage.removeItem('relay-broker-config')
    }
  }, [])

  return <div className="connection-page">
    <section className="panel connection-hero">
      <div className="connection-heading-row">
        <div className="hero-icon"><Radio size={26} /></div>
        <button className="back-button" onClick={onDashboard}><ChevronRight size={16} /> Back to dashboard</button>
      </div>
      <p className="section-label">DEVICE SETUP</p>
      <h2>Connect your ESP32</h2>
      <p>Use your internet broker address and device ID. The dashboard and ESP32 do not need to share the same Wi-Fi network.</p>
      <div className="mobile-address-card">
        <span>OPEN FROM THIS PHONE</span>
        <strong>{dashboardAddress}</strong>
        <small>The dashboard and ESP32 can be on different Wi-Fi networks; both need internet access.</small>
      </div>
      <div className="connection-fields">
        <label>ESP32 device ID<input value={deviceId} onChange={(event) => { setDeviceId(event.target.value); setSaved(false) }} placeholder="ESP32-RELAY-01" /></label>
        <label>MQTT broker endpoint<input value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setSaved(false) }} placeholder="broker.example.com:8883" /></label>
        <label>MQTT port<input type="number" min="1" max="65535" value={brokerPort} onChange={(event) => setBrokerPort(event.target.value)} /></label>
        <label>MQTT username<input value={mqttUser} onChange={(event) => setMqttUser(event.target.value)} placeholder="Broker username" /></label>
        <label>MQTT password<input type="password" value={mqttPassword} onChange={(event) => setMqttPassword(event.target.value)} placeholder="Broker password" /></label>
        <label>Command topic<input value={commandTopic} onChange={(event) => setCommandTopic(event.target.value)} placeholder="device/cmd" /></label>
        <label>Status topic<input value={statusTopic} onChange={(event) => setStatusTopic(event.target.value)} placeholder="device/status/json" /></label>
        <label>Acknowledgement topic<input value={ackTopic} onChange={(event) => setAckTopic(event.target.value)} placeholder="device/ack" /></label>
      </div>
      <button className="listen-button" onClick={() => void saveConnection()} disabled={!deviceId.trim() || !endpoint.trim() || connecting}><Check size={18} /> {connecting ? 'Connecting…' : saved ? 'Connected and saved' : 'Connect and save'}</button>
      {connectionMessage && <p className="connection-message">{connectionMessage}</p>}
      <div className={`connection-state ${connected ? 'online' : 'offline'}`} role="status" aria-live="polite"><i className="status-dot" /><span>{connected ? 'ESP32 heartbeat received' : connectionIssue || 'Waiting for ESP32 heartbeat'}</span></div>
    </section>
    <section className="panel setup-panel">
      <div className="panel-heading"><div><p className="section-label">CONNECTION REVIEW</p><h2>Connection path</h2></div><span className={`relay-status ${connected ? '' : 'offline-status'}`}><i className="status-dot" /> {connected ? 'Healthy' : 'Waiting'}</span></div>
      <div className="step-list">{[['01', Smartphone, 'Dashboard microphone', 'Voice is captured in your browser'], ['02', Cloud, 'Internet MQTT broker', endpoint || 'Broker endpoint required'], ['03', Cpu, 'ESP32 vibration relay', connected ? 'Online · ready for commands' : 'Offline · waiting for heartbeat']].map(([number, Icon, title, detail]) => <div className="step-row" key={number as string}><span className="step-number">{number as string}</span><div className="step-icon"><Icon size={18} /></div><div><strong>{title as string}</strong><span>{detail as string}</span></div><Check size={17} className={`check-icon ${connected ? '' : 'muted-check'}`} /></div>)}</div>
      <div className="security-note"><ShieldCheck size={17} /><span>The broker password is not saved in this browser. For reliable production reconnects, configure MQTT_USER and MQTT_PASSWORD as server-side project variables.</span></div>
      <button className="secondary-dashboard-button" onClick={onDashboard}>Return to dashboard <ChevronRight size={16} /></button>
    </section>
  </div>
}
