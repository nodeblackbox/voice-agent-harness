import { app, BrowserWindow, nativeTheme, protocol, session, shell } from 'electron'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { IPC } from '@shared/ipc'
import type { AgentEvent, AudioChunk, CloudTtsProvider, ServiceStatus, Settings } from '@shared/types'
import { TTS_ENGINE_LABELS, isCloudTts, requestFields } from '@shared/tts'
import { earConfig } from '@shared/tuning'
import { Agent, type CloudTtsEngine } from '@core/agent'
import { ElevenLabsEngine, FishEngine, InworldEngine, type CloudTtsDeps } from '@core/speech/cloud'
import { QwenEngine } from '@core/speech/qwen'
import { MemoryStore } from '@core/memory/store'
import { findModel } from '@core/providers/models'
import { resolveModel } from '@core/providers/resolve'
import { initLog, log, logAt, logError, trace, tracePath, type LogLevel } from './services/log'
import { SettingsService } from './services/settings'
import { SidecarService } from './services/sidecar'
import { SearxngService } from './services/searxng'
import { KokoroService } from './services/kokoro'
import { ClaudeService } from './services/claude'
import { announcement } from '@core/claude/announce'
import { McpService } from './services/mcp'
import { registerIpc } from './ipc/register'
import { setupTraining } from './training'

const here = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(here, '..', '..')
const isDev = !app.isPackaged

app.setName('Voice Agent')
// VA_USER_DATA=<dir>: run against a separate data folder (fresh-user testing, screenshots) without touching the real one
if (isDev && process.env.VA_USER_DATA) {
  const dir = resolve(process.env.VA_USER_DATA)
  app.setPath('userData', dir)
  app.setPath('sessionData', join(dir, 'session'))
}
// Live preview of Claude Code workspaces (served read-only by ClaudeService.serve)
protocol.registerSchemesAsPrivileged([{ scheme: 'ccws', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let win: BrowserWindow | null = null

// the window's own background shows before the renderer paints, so it has to match the chosen theme
const WINDOW_BG = { dark: '#0B0D10', light: '#FBF7F0' } as const

/** Tells Chromium which theme native widgets (scrollbars, <select> popups) should use; returns the one in effect. */
function applyNativeTheme(s: Settings): 'dark' | 'light' {
  const pref = s.behaviour.theme ?? 'dark'
  nativeTheme.themeSource = pref
  return pref === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : pref
}

function createWindow(theme: 'dark' | 'light'): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: WINDOW_BG[theme],
    title: 'Voice Agent',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Chromium's PDF viewer, for PDFs a Claude session writes (shown in the workspace file viewer)
      plugins: true,
      backgroundThrottling: false
    }
  })
  w.once('ready-to-show', () => {
    w.show()
    const shot = process.env.VA_SCREENSHOT
    if (isDev && shot) {
      setTimeout(async () => {
        const img = await w.webContents.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(shot, img.toPNG())
        log('app', `screenshot -> ${shot}`)
      }, Number(process.env.VA_SCREENSHOT_DELAY ?? 4000))
    }
  })
  w.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') logAt(event.level === 'error' ? 'error' : 'warn', 'renderer', `${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(here, '../renderer/index.html'))
  return w
}

// Leaf paths whose value changed between two settings objects, e.g. { 'endpoint.prerollMs': 1000 }.
function changedPaths(a: unknown, b: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out)
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out[prefix] = b
  return out
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const settings = new SettingsService(userData, join(projectRoot, '.env'), { defaultWorkspaceRoot: join(app.getPath('documents'), 'VoiceAgentWorkspaces') })
  initLog(userData, {
    level: () => settings.get().runtime.logLevel as LogLevel,
    transcripts: () => settings.get().runtime.logTranscripts
  })
  log('app', `starting (dev=${isDev}) root=${projectRoot} userData=${userData}`)
  if (settings.migrations.length) {
    log('settings', `migrated defaults: ${settings.migrations.map((m) => `${m.group}.${m.key} ${String(m.from)}→${String(m.to)}`).join(', ')}`)
    trace({ ev: 'settings.migrated', migrated: settings.migrations })
  }

  // Electron would show a modal "A JavaScript error occurred in the main process" and leave nothing
  // in our logs; record it with its stack, tell the user once, and keep running.
  const crashed = new Set<string>()
  const onCrash = (kind: string, err: unknown): void => {
    const e = err as { message?: string; stack?: string } | undefined
    logError('main', kind, err)
    trace({ ev: 'app.crash', kind, message: e?.message ?? String(err), stack: e?.stack?.split('\n').slice(0, 12).join('\n') })
    const key = `${kind}:${e?.message ?? String(err)}`
    if (crashed.has(key)) return
    crashed.add(key)
    emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'error', text: `Internal error (${kind}): ${e?.message ?? String(err)}. Logged to errors.log.` } })
  }
  process.on('uncaughtException', (err) => onCrash('uncaughtException', err))
  process.on('unhandledRejection', (reason) => onCrash('unhandledRejection', reason))

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'speaker-selection', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'speaker-selection'].includes(permission))

  const store = new MemoryStore(join(userData, 'memory.sqlite'))
  for (const p of store.projects()) store.ensureScope(p.id, p.name)

  const send = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const emitRef = { current: (event: AgentEvent): void => send(IPC.event, event) }
  // opt-in voice-clone dataset capture (RECORD_TRAINING_DATA=1); null when off
  const training = setupTraining({
    env: (name) => settings.envVar(name),
    userData,
    appVersion: app.getVersion(),
    log: (m) => log('training', m),
    notify: (text) => emitRef.current({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'info', text } })
  })
  const emit = (event: AgentEvent): void => {
    training?.onAgentEvent(event)
    emitRef.current(event)
  }
  const statuses = new Map<ServiceStatus['name'], ServiceStatus>()
  const onStatus = (status: ServiceStatus): void => {
    statuses.set(status.name, status)
    emit({ type: 'service', status })
  }

  const sidecar = new SidecarService({
    projectRoot,
    stt: () => settings.get().stt,
    earConfig: () => earConfig(settings.get()),
    idleShutdownMs: () => settings.get().runtime.idleShutdownMs,
    onStatus,
    trace,
    onEvent: (evt) => {
      training?.onEarEvent(evt)
      if (evt.type !== 'level' && evt.type !== 'pong') {
        const { type, ...data } = evt as Record<string, unknown> & { type: string }
        // the sidecar's `t` is its own perf-counter clock; keep it, but never under the trace's timestamp key
        if ('t' in data) {
          data.earT = data.t
          delete data.t
        }
        trace({ ...data, ev: `ear.${type}`, sid: agent.currentSessionId })
      }
      switch (evt.type) {
        case 'speech_start':
          agent.onSpeechStart()
          break
        case 'partial':
          agent.onPartial(evt.text)
          break
        case 'speech_end':
          agent.onSpeechEnd({ reason: evt.reason, silenceMs: evt.silenceMs, turnP: evt.turnP, speechMs: evt.speechMs, capMs: evt.capMs ?? null, segments: evt.segments })
          break
        case 'segment':
          agent.onSegment(evt.text, evt.index)
          break
        case 'final':
          agent.onFinal(evt.text, evt.asrMs, { afterCut: evt.afterCut === true, durationMs: evt.durationMs, queuedMs: evt.queuedMs, segments: evt.segments })
          break
        case 'bargein':
          agent.onBargeIn(evt.stage)
          break
        case 'level':
          emit({ type: 'level', p: evt.p })
          break
        case 'error':
          if (!evt.fatal) logAt('warn', 'ear', `error: ${evt.message}`)
          else if (evt.code === 'asr_hung') emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'warn', text: 'Speech recognition froze (the graphics card is probably busy with other apps) and is restarting. Speak again in a few seconds.' } })
          else if (evt.code === 'asr_broken') emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'warn', text: 'The ears hit a GPU error and are restarting. Check what else is using the graphics card if it keeps happening.' } })
          break
        default:
          break
      }
    }
  })

  const searxng = new SearxngService({ projectRoot, url: () => settings.get().searxng.url, onStatus })
  const kokoro = new KokoroService({ projectRoot, python: () => sidecar.resolvePython(), voice: () => settings.get().voice.kokoroVoice })
  const mcp = new McpService({
    projectRoot,
    userData,
    projectPath: () => store.projects().find((p) => p.id === settings.get().projectId)?.path ?? '',
    enabled: () => settings.get().mcp.enabled,
    onStatus
  })

  const claude = new ClaudeService(userData, () => settings.get())
  protocol.handle('ccws', (req) => claude.serve(req))

  // Hosted voices. One proxy URL serves both the Edge socket (an https Agent) and the HTTP engines (an undici
  // dispatcher); each is built once per URL and only used when its toggle is on.
  let proxy: { url: string; agent: HttpsProxyAgent<string>; dispatcher: ProxyAgent } | null = null
  const proxyFor = (url: string) => {
    if (!url) return null
    if (proxy?.url !== url) {
      try {
        proxy = { url, agent: new HttpsProxyAgent(url), dispatcher: new ProxyAgent(url) }
      } catch (e) {
        logAt('warn', 'tts', `bad proxy URL: ${(e as Error).message}`)
        return null
      }
    }
    return proxy
  }
  const edgeAgent = (): unknown => (settings.get().voice.proxy.edge ? proxyFor(settings.get().voice.proxy.url)?.agent : undefined)
  const cloudAgent = (): unknown => (settings.get().voice.proxy.cloud ? proxyFor(settings.get().voice.proxy.url)?.agent : undefined)
  const cloudFetch: typeof fetch = (input, init) => {
    const d = settings.get().voice.proxy.cloud ? proxyFor(settings.get().voice.proxy.url)?.dispatcher : undefined
    if (!d) return fetch(input, init)
    return undiciFetch(input as never, { ...(init as object), dispatcher: d } as never) as unknown as Promise<Response>
  }
  const cloudDeps = (p: CloudTtsProvider): CloudTtsDeps => ({
    key: () => settings.keysFor(p)[0] ?? '',
    fetch: cloudFetch,
    timeoutMs: () => settings.get().speech.ttsTimeoutMs,
    log: (m) => log('tts', m)
  })
  const cloudTts: Record<CloudTtsProvider, CloudTtsEngine> = {
    elevenlabs: new ElevenLabsEngine(cloudDeps('elevenlabs')),
    fish: new FishEngine(cloudDeps('fish')),
    inworld: new InworldEngine(cloudDeps('inworld')),
    qwen: new QwenEngine({
      key: () => settings.keysFor('qwen')[0] ?? '',
      host: () => settings.qwenHost(),
      agent: cloudAgent,
      poolSize: settings.get().speech.ttsPoolSize,
      timeoutMs: () => settings.get().speech.ttsTimeoutMs,
      log: (m) => log('tts', m)
    })
  }

  const agent = new Agent({
    store,
    settings: () => training?.settings(settings.get()) ?? settings.get(),
    keys: settings,
    customStyles: () => (training ? [...settings.styles(), ...training.styles] : settings.styles()),
    skills: () => settings.skills(),
    mcp,
    claude: claude.manager,
    search: { baseUrl: () => searxng.baseUrl(), ensure: () => searxng.ensure(), configured: () => searxng.configured() },
    ears: {
      agentSpeaking: (on) => sidecar.agentSpeaking(on),
      agentThinking: (on) => sidecar.agentThinking(on),
      // only when connected: if the sidecar is already restarting itself (asr_hung), leave it be
      restartStuck: () => sidecar.ready && sidecar.restart()
    },
    kokoro,
    cloudTts,
    edgeAgent,
    emit,
    emitAudio: (chunk: AudioChunk) => send(IPC.audioChunk, chunk),
    cancelAudio: (turnId) => send(IPC.audioCancel, turnId),
    log: (m) => log('agent', m),
    trace
  })

  const ttsStatus = (): ServiceStatus => {
    const v = settings.get().voice
    const noKey = isCloudTts(v.engine) && !settings.keysFor(v.engine).length
    const raw = requestFields(v, v.engine).voice
    const voice = v.engine === 'edge' ? raw.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/(Multilingual)?Neural$/, '') : raw
    return {
      name: 'tts',
      state: v.engine === 'system' ? 'off' : noKey ? 'error' : 'ready',
      detail: noKey ? `${TTS_ENGINE_LABELS[v.engine]}: no API key` : `${TTS_ENGINE_LABELS[v.engine]}${voice ? ` · ${voice.length > 28 ? `${voice.slice(0, 26)}…` : voice}` : ''}${kokoro.ready() ? ' · Kokoro loaded' : ''}`
    }
  }

  const services = (): ServiceStatus[] => {
    const wanted = findModel(settings.get().modelId)
    const resolved = resolveModel(settings.get().modelId, settings)
    const hasKey = !!resolved
    const model = resolved?.model ?? wanted
    return [
      sidecar.status,
      ttsStatus(),
      {
        name: 'llm',
        state: hasKey ? 'ready' : 'error',
        detail: !hasKey ? 'no API key for any provider' : resolved?.substituted ? `${model?.label} (no key for ${resolved.substituted.from.providerLabel})` : model?.label
      },
      searxng.status,
      mcp.status
    ]
  }

  let previousSettings: Settings = settings.get()
  settings.onChange((s: Settings) => {
    const changed = changedPaths(previousSettings, s)
    previousSettings = s
    if (Object.keys(changed).length) trace({ ev: 'settings.changed', sid: agent.currentSessionId, changed })
    if ('behaviour.theme' in changed) applyNativeTheme(s)
    if (Object.keys(changed).some((k) => k.startsWith('voice.proxy'))) agent.resetTts()
    sidecar.applyConfig()
    emit({ type: 'settings-changed', settings: s })
    emit({ type: 'context', snapshot: agent.snapshot() })
  })
  let lastStt = JSON.stringify(settings.get().stt)
  let lastProject = settings.get().projectId
  settings.onChange((s) => {
    const stt = JSON.stringify(s.stt)
    if (stt !== lastStt) {
      lastStt = stt
      sidecar.restart()
    }
    if (s.projectId !== lastProject) {
      lastProject = s.projectId
      void mcp.reload()
    }
  })

  registerIpc({
    win: () => win,
    agent,
    store,
    settings,
    sidecar,
    searxng,
    mcp,
    claude,
    services,
    broadcastSettings: (s) => emit({ type: 'settings-changed', settings: s })
  })

  win = createWindow(applyNativeTheme(settings.get()))
  win.on('closed', () => {
    win = null
  })

  // The ears hold Parakeet on the GPU and several GB of RAM, so they are only started when the
  // microphone is actually wanted. Typed chat never needs them.
  // the dev replay harnesses wait for the ears, so they start them too
  if (settings.get().behaviour.listenOnLaunch || (isDev && (process.env.VA_WAV || process.env.VA_MIC))) sidecar.start()
  void mcp.reload()
  // Claude session events: stream to the UI, and speak the ones that need the user (a question, an approval, a finished job)
  const lastCcStatus = new Map<string, string>()
  claude.manager.on((event) => {
    emit({ type: 'claude', event })
    if (event.type === 'session') {
      const s = event.session
      if (lastCcStatus.get(s.id) !== s.status) {
        lastCcStatus.set(s.id, s.status)
        trace({ ev: 'cc.status', sid: agent.currentSessionId, session: s.name, status: s.status, queued: s.queued.length, costUsd: Number(s.costUsd.toFixed(4)) })
      }
    } else if (event.type === 'needs-input') trace({ ev: 'cc.needs_input', sid: agent.currentSessionId, session: event.name, kind: event.pending.kind, summary: event.pending.summary.slice(0, 160) })
    else if (event.type === 'finished') trace({ ev: 'cc.finished', sid: agent.currentSessionId, session: event.name, chars: event.summary.length })
    else if (event.type === 'event' && event.event.kind === 'denied') trace({ ev: 'cc.denied', sid: agent.currentSessionId, reason: event.event.text.slice(0, 200) })
    if (!claude.enabled()) return
    const line = announcement(event)
    if (line) agent.announce(line)
  })
  if (isDev && process.env.VA_SAY) setTimeout(() => void agent.send(process.env.VA_SAY!), 4000)
  if (isDev && process.env.VA_VIEW) {
    // switch to a rail view by its label (e.g. Diagnostics) before a VA_SCREENSHOT is taken
    setTimeout(() => {
      void win?.webContents
        .executeJavaScript(`(() => { const b = document.querySelector('button[aria-label="${process.env.VA_VIEW!.replace(/"/g, '')}"]'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`)
        .then((r) => log('devtools', `view ${process.env.VA_VIEW}: ${String(r)}`))
    }, Number(process.env.VA_VIEW_DELAY ?? 12000))
  }
  if (isDev && process.env.VA_MIC) {
    // press the Voice button from outside to exercise the real getUserMedia -> worklet -> sidecar path
    const press = (): void => {
      void win?.webContents
        .executeJavaScript(`(() => { const b = document.querySelector('button[aria-label="Start voice"]'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`)
        .then((r) => log('devtools', `voice button: ${String(r)}`))
    }
    const poll = setInterval(() => {
      if (sidecar.ready && win) {
        clearInterval(poll)
        setTimeout(press, 1500)
      }
    }, 500)
  }
  if (isDev && process.env.VA_WAV) {
    const stateListeners: Array<(s: string) => void> = []
    const origEmit = emitRef.current
    emitRef.current = (event) => {
      if (event.type === 'state') for (const fn of stateListeners) fn(event.state)
      origEmit(event)
    }
    const { replayWav } = await import('./services/devtools')
    const start = (): void =>
      replayWav({ wav: process.env.VA_WAV!, bargeInWav: process.env.VA_WAV2, sidecar, agent, onState: (fn) => stateListeners.push(fn) })
    const poll = setInterval(() => {
      if (sidecar.ready) {
        clearInterval(poll)
        setTimeout(start, 1000)
      }
    }, 500)
  }
  void searxng.health().then((ok) => {
    if (!ok && settings.get().searxng.autostart) void searxng.ensure()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow(applyNativeTheme(settings.get()))
  })

  app.on('before-quit', () => {
    agent.shutdown()
    training?.recorder.dispose()
    // VA_TRACE=1: print where this session's trace landed so scripted runs can pick it up
    if (process.env.VA_TRACE) console.log(`VA_TRACE ${tracePath() ?? 'none'}`)
    sidecar.stop()
    kokoro.stop()
    searxng.stop()
    void mcp.stop()
    void claude.stop()
    store.close()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
