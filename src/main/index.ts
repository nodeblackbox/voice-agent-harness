import { app, BrowserWindow, nativeTheme, protocol, session, shell } from 'electron'
import { appendFile, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
import { initLog, log, logAt, logError, onConsole, trace, tracePath, type LogLevel } from './services/log'
import type { ConsoleEntry } from '@shared/console'
import { SettingsService } from './services/settings'
import { SidecarService } from './services/sidecar'
import { SearxngService } from './services/searxng'
import { KokoroService } from './services/kokoro'
import { PocketService } from './services/pocket'
import { EdgeRouteService, ipCountries } from './services/edgeRoute'
import { edgeProbe } from '@core/speech/proxyRank'
import { SlowVoiceWatch, quickTwin } from '@core/speech/voiceSpeed'
import { ClaudeService } from './services/claude'
import { announcement } from '@core/claude/announce'
import { McpService } from './services/mcp'
import { registerIpc } from './ipc/register'
import { PlaybookService } from './services/playbooks'
import { RunbookRunStore } from './services/runbookRuns'
import { changedFiles } from './services/gitStatus'
import { PlaybookLabels, PlaybookReview } from './services/playbookReview'
import { JevClient } from '@core/jev/client'
import { testPlaybook } from '@core/playbooks/test-run'
import { usesJev } from '@core/playbooks/schema'
import { DiagramService } from './services/diagrams'
import { firstRunRoots } from '@core/explore/roots'
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

  // This app's own source folder, when it runs from source: the agent's active project when none is picked, so
  // "change yourself" can start a Claude Code session there. A packaged build has no source to edit.
  const appDir = isDev && existsSync(join(projectRoot, 'package.json')) && existsSync(join(projectRoot, 'src')) ? projectRoot : null
  // PC access starts with the folders the app already works in; the owner adds drives and others in Settings.
  if (!settings.get().explore.seeded) {
    const roots = firstRunRoots([...settings.get().explore.roots, appDir, settings.get().claude.workspaceRoot, ...store.projects().map((p) => p.path)])
    settings.set({ explore: { ...settings.get().explore, roots, seeded: true } })
    log('settings', `PC access: starting with ${roots.length} approved folder${roots.length === 1 ? '' : 's'}`)
  }

  const send = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const emitRef = { current: (event: AgentEvent): void => send(IPC.event, event) }
  // the live console: entries go to the window in batches, so a burst of events is one IPC message
  let consoleBatch: ConsoleEntry[] = []
  let consoleTimer: NodeJS.Timeout | null = null
  onConsole((e) => {
    consoleBatch.push(e)
    consoleTimer ??= setTimeout(() => {
      consoleTimer = null
      const batch = consoleBatch
      consoleBatch = []
      send(IPC.consoleEntries, batch)
    }, 120)
  })
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
    idleShutdownMs: () => (settings.get().behaviour.keepEarsLoaded ? 0 : settings.get().runtime.idleShutdownMs),
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
  // Pocket TTS: a local server, started when it is the chosen voice (the command or address comes from Settings or .env)
  const pocket = new PocketService({ server: () => settings.get().voice.pocketServer ?? '', voice: () => settings.get().voice.pocketVoice?.trim() || 'cosette', env: { ...process.env, ...(settings.envVar('POCKET_TTS_COMMAND') ? { POCKET_TTS_COMMAND: settings.envVar('POCKET_TTS_COMMAND') } : {}) } })
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
  const proxies = new Map<string, { agent: HttpsProxyAgent<string>; dispatcher: ProxyAgent }>()
  const proxyFor = (url: string) => {
    if (!url) return null
    let p = proxies.get(url)
    if (!p) {
      try {
        p = { agent: new HttpsProxyAgent(url), dispatcher: new ProxyAgent(url) }
        proxies.set(url, p)
      } catch (e) {
        logAt('warn', 'tts', `bad proxy URL: ${(e as Error).message}`)
        return null
      }
    }
    return p
  }

  // Edge's route: automatic (direct while quick, the fastest proxy when throttled) when a proxy list exists,
  // else the hand-set proxy URL behind the Edge toggle. The list is Settings > Proxy list plus PROXY_LIST_URL.
  let fetchedList: { at: number; text: string } | null = null
  const listCache = join(userData, 'proxy-list.txt')
  const proxyLines = async (): Promise<string> => {
    const own = settings.get().voice.proxy.list ?? ''
    const url = settings.proxyListUrl()
    if (!url) return own
    if (!fetchedList || Date.now() - fetchedList.at > 3600_000) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        const text = await res.text()
        if (!res.ok || !/^\S+:\d+/m.test(text)) throw new Error(`${res.status} ${text.slice(0, 80)}`)
        fetchedList = { at: Date.now(), text }
        writeFileSync(listCache, text)
      } catch (e) {
        logAt('warn', 'tts', `couldn't fetch PROXY_LIST_URL (${(e as Error).message}); using the last copy`)
        fetchedList = { at: Date.now(), text: existsSync(listCache) ? readFileSync(listCache, 'utf8') : '' }
      }
    }
    return `${own}
${fetchedList.text}`
  }
  const edgeRoute = new EdgeRouteService({
    userData,
    lines: proxyLines,
    probe: edgeProbe((url) => proxyFor(url)?.agent, () => settings.get().voice.voice || 'en-US-AvaNeural', 10_000),
    geo: ipCountries,
    log: (m) => log('tts', m),
    trace: (ev, data) => trace({ ev, sid: agent.currentSessionId, ...data }),
    onChange: (s) => emit({ type: 'edge-route', state: s }),
    parallel: () => settings.get().speech.proxyRankParallel
  })
  const autoRoute = (): boolean => settings.get().voice.proxy.auto !== false && edgeRoute.state().proxies > 0
  const edgeAgent = (): unknown => {
    const p = settings.get().voice.proxy
    if (autoRoute()) return proxyFor(edgeRoute.current())?.agent
    return p.edge ? proxyFor(p.url)?.agent : undefined
  }
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

  const diagrams = new DiagramService(userData, send, (doc, id) => emit({ type: 'diagram', id, doc }))
  // runbook runs, one JSON file each, so a run waiting for the user's reply survives a restart
  const runbookRuns = new RunbookRunStore(join(userData, 'runbooks', 'runs'), (m) => logAt('warn', 'runbooks', m))
  // reviews of playbook triggers: the user's marks, and Jev or the model as the judge (set up below, once Jev exists)
  const playbookLabels = new PlaybookLabels(join(userData, 'playbook-labels.json'))
  // Jev, the playbooks' decision model: TypeSafe's API, or another server speaking it (JEV_BASE_URL, e.g. a local jevos)
  const jev = new JevClient({ key: () => settings.keysFor('typesafe')[0], baseUrl: () => settings.envVar('JEV_BASE_URL') ?? '', model: () => settings.envVar('JEV_MODEL') ?? '' })
  const review = new PlaybookReview({
    settings: () => settings.get(),
    keys: settings,
    store,
    jev,
    labels: playbookLabels,
    source: (id) => playbooks.state().playbooks.find((p) => p.id === id)?.source,
    trace: (ev, data) => trace({ ev, sid: agent.currentSessionId, ...data })
  })
  // playbooks (docs/TRIGGERS.md): one .md file each in <userData>/playbooks, re-read when they change
  const playbooks = new PlaybookService(join(userData, 'playbooks'), {
    log: (level, m) => logAt(level, 'playbooks', m),
    trace: (ev, data) => trace({ ev, sid: agent.currentSessionId, ...data }),
    changed: () => emit({ type: 'playbooks-changed' }),
    jev: () => (!settings.get().playbooks.useJev ? 'off' : jev.configured() ? 'ready' : 'no_key')
  })

  const agent = new Agent({
    store,
    settings: () => training?.settings(settings.get()) ?? settings.get(),
    keys: settings,
    customStyles: () => (training ? [...settings.styles(), ...training.styles] : settings.styles()),
    skills: () => settings.skills(),
    playbooks: () => playbooks.playbooks(),
    jev,
    // the playbook_* tools: the same folder, saves and history as the Playbooks view; replay never asks Jev (it is free)
    playbookAdmin: {
      state: () => playbooks.state(),
      save: (id, text, previousId, by) => playbooks.save(id, text, previousId, by),
      toggle: (id, on, by) => playbooks.toggle(id, on, by),
      delete: (id, by) => playbooks.delete(id, by),
      undo: () => playbooks.undo('voice'),
      replay: async (id, text) => (await testPlaybook(id, text, store.recentUserMessages(40), { ...settings.get().playbooks })).rows,
      evaluate: (id) => review.evaluate(id),
      label: (id, messageId, label) => review.label(id, messageId, label),
      suggest: (id) => review.suggest(id),
      previousUserMessage: () => review.previousUserMessage()
    },
    runbookStore: runbookRuns,
    mcp,
    claude: claude.manager,
    diagrams: { library: diagrams.library, check: diagrams.check },
    appDir: () => appDir,
    // the explorer module: copies of files as they were before an edit, and one line per action taken or refused
    explore: {
      backupDir: join(userData, 'pc-edit-backups'),
      log: (a) => appendFile(join(userData, 'logs', 'pc-actions.jsonl'), `${JSON.stringify(a)}
`, (err) => err && logAt('warn', 'explore', `could not write the action log: ${err.message}`))
    },
    search: { baseUrl: () => searxng.baseUrl(), ensure: () => searxng.ensure(), configured: () => searxng.configured() },
    ears: {
      agentSpeaking: (on) => sidecar.agentSpeaking(on),
      agentThinking: (on) => sidecar.agentThinking(on),
      // only when connected: if the sidecar is already restarting itself (asr_hung), leave it be
      restartStuck: () => sidecar.ready && sidecar.restart()
    },
    kokoro,
    pocket,
    cloudTts,
    edgeAgent,
    emit,
    emitAudio: (chunk: AudioChunk) => send(IPC.audioChunk, chunk),
    cancelAudio: (turnId) => send(IPC.audioCancel, turnId),
    log: (m) => log('agent', m),
    // Edge's per-sentence timings and failures steer the automatic route
    trace: (rec) => {
      trace(rec)
      if (rec.ev === 'trigger.fired' && typeof rec.id === 'string') playbooks.noteFired(rec.id)
      if (rec.ev === 'tts.sentence' && rec.engine === 'edge' && rec.kind === 'speech' && rec.outcome === 'ok' && typeof rec.ms === 'number') {
        const voice = settings.get().voice.voice
        const slow = slowVoice.sample(voice, rec.ms)
        if (slow !== null) void reportSlowVoice(voice, slow)
      }
      if (!autoRoute()) return
      if (rec.ev === 'tts.sentence' && rec.engine === 'edge' && typeof rec.firstByteMs === 'number') edgeRoute.sentence(rec.firstByteMs, settings.get().speech.edgeSlowMs)
      if (rec.ev === 'tts.engine_down' && rec.engine === 'edge') edgeRoute.trouble(String(rec.reason ?? 'down'))
    }
  })

  try {
    playbooks.start()
    agent.resumeRunbooks()
    agent.startClock()
  } catch (e) {
    logError('playbooks', 'could not set up the playbooks folder', e)
  }
  // the first Jev call of a run pays for the connection; pay it now, when some playbook will need Jev
  if (settings.get().playbooks.useJev && playbooks.playbooks().some((p) => p.enabled && usesJev(p))) {
    void jev.warm().then((ms) => ms !== null && trace({ ev: 'jev.warm', sid: agent.currentSessionId, ms }))
  }

  // The chosen Edge voice keeps answering slowly: time the plain voice of the same name once the agent is
  // quiet, and offer it when it is clearly quicker. No route change fixes a slow voice (see voiceSpeed.ts).
  const slowVoice = new SlowVoiceWatch()
  const reportSlowVoice = async (voice: string, ms: number): Promise<void> => {
    try {
      for (let i = 0; i < 60 && agent.busy; i++) await new Promise((r) => setTimeout(r, 1000))
      if (settings.get().voice.voice !== voice || settings.get().voice.engine !== 'edge') return
      const twin = quickTwin(voice, (await agent.voices()).map((v) => v.shortName))
      const twinMs = twin ? await agent.voiceSpeed(twin, 3) : undefined
      trace({ ev: 'tts.voice_slow', sid: agent.currentSessionId, voice, ms, twin, twinMs })
      log('tts', `${voice} is slow: ${ms} ms a sentence${twin ? `; ${twin} measured ${twinMs} ms` : ''}`)
      if (twin && twinMs !== undefined && twinMs * 1.6 < ms) emit({ type: 'voice-slow', notice: { voice, ms, twin, twinMs } })
      else if (!twin) emit({ type: 'voice-slow', notice: { voice, ms } })
    } catch (e) {
      log('tts', `slow-voice check failed: ${(e as Error).message}`)
    }
  }

  const ttsStatus = (): ServiceStatus => {
    const v = settings.get().voice
    const noKey = isCloudTts(v.engine) && !settings.keysFor(v.engine).length
    const raw = requestFields(v, v.engine).voice
    const voice = v.engine === 'edge' ? raw.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/(Multilingual)?Neural$/, '') : raw
    if (v.engine === 'pocket') {
      const p = pocket.state()
      const who = `${TTS_ENGINE_LABELS.pocket} · ${v.pocketVoice?.trim() || 'cosette'}`
      if (p.state === 'ready') return { name: 'tts', state: 'ready', detail: who }
      if (p.state === 'loading') return { name: 'tts', state: 'starting', detail: `${TTS_ENGINE_LABELS.pocket}: loading… Edge speaks until it is ready` }
      if (p.state === 'failed') return { name: 'tts', state: 'error', detail: `${TTS_ENGINE_LABELS.pocket} failed: ${p.error.slice(0, 120)}` }
      return { name: 'tts', state: 'starting', detail: `${TTS_ENGINE_LABELS.pocket}: not started yet` }
    }
    if (v.engine === 'kokoro') {
      const k = kokoro.state()
      const who = `${TTS_ENGINE_LABELS.kokoro} · ${v.kokoroVoice}`
      if (k.state === 'ready') return { name: 'tts', state: 'ready', detail: who }
      if (k.state === 'loading') return { name: 'tts', state: 'starting', detail: `${TTS_ENGINE_LABELS.kokoro}: loading… Edge speaks until it is ready` }
      if (k.state === 'failed') return { name: 'tts', state: 'error', detail: `${TTS_ENGINE_LABELS.kokoro} failed: ${k.error.slice(0, 80)}` }
      return { name: 'tts', state: 'starting', detail: `${TTS_ENGINE_LABELS.kokoro}: not loaded yet` }
    }
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
    // picking Kokoro loads it now (30-60 s), not on the first sentence of the next reply
    if (changed['voice.engine'] === 'kokoro') void kokoro.start({ force: true })
    // the same for Pocket TTS; a new command, address or default voice restarts its server
    if (changed['voice.engine'] === 'pocket') void pocket.start({ force: true })
    if (('voice.pocketServer' in changed || 'voice.pocketVoice' in changed) && s.voice.engine === 'pocket') {
      pocket.stop()
      void pocket.start({ force: true })
    }
    // switched on: load the ears now; switched off: the idle timer applies from the next time the mic closes
    if (changed['behaviour.keepEarsLoaded'] === true) sidecar.start()
    // a new proxy list, or automatic routing switched on: test it (a full test when the list changed)
    if ('voice.proxy.list' in changed || changed['voice.proxy.auto'] === true) void edgeRoute.start()
    if (Object.keys(changed).some((k) => k.startsWith('voice.'))) onStatus(ttsStatus())
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
    diagrams,
    playbooks,
    review,
    jev,
    services,
    edgeRoute,
    kokoro,
    pocket,
    broadcastSettings: (s) => emit({ type: 'settings-changed', settings: s })
  })

  // Kokoro's loading state drives the voice status chip; say when it is ready or failed, if it is the chosen voice
  kokoro.onState((k) => {
    onStatus(ttsStatus())
    trace({ ev: 'tts.kokoro_state', sid: agent.currentSessionId, state: k.state, ...(k.state === 'failed' ? { error: k.error.slice(0, 200) } : {}) })
    if (settings.get().voice.engine !== 'kokoro') return
    if (k.state === 'ready') emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'info', text: 'Kokoro is loaded; replies use it from now on.' } })
    if (k.state === 'failed') emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'error', text: `Kokoro couldn't load (${k.error.slice(0, 100)}); Edge keeps speaking. Pick Kokoro again to retry.` } })
  })
  if (settings.get().voice.engine === 'kokoro') void kokoro.start()
  pocket.onState((p) => {
    onStatus(ttsStatus())
    trace({ ev: 'tts.pocket_state', sid: agent.currentSessionId, state: p.state, ...(p.state === 'ready' ? { url: p.url } : {}), ...(p.state === 'failed' ? { error: p.error.slice(0, 200) } : {}) })
    if (settings.get().voice.engine !== 'pocket') return
    if (p.state === 'ready') emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'info', text: 'Pocket TTS is ready; replies use it from now on.' } })
    if (p.state === 'failed') emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind: 'error', text: `Pocket TTS couldn't start (${p.error.slice(0, 140)}); Edge keeps speaking.` } })
  })
  if (settings.get().voice.engine === 'pocket') void pocket.start()
  // pick Edge's route in the background; the first reply goes direct if this is still running
  if (settings.get().voice.proxy.auto !== false) void edgeRoute.start()

  win = createWindow(applyNativeTheme(settings.get()))
  win.on('closed', () => {
    win = null
  })

  // The ears hold Parakeet on the GPU and several GB of RAM, so they are only started when the
  // microphone is actually wanted. Typed chat never needs them.
  // the dev replay harnesses wait for the ears, so they start them too
  if (settings.get().behaviour.listenOnLaunch || settings.get().behaviour.keepEarsLoaded || (isDev && (process.env.VA_WAV || process.env.VA_MIC))) sidecar.start()
  void mcp.reload()
  // Claude session events: stream to the UI, and speak the ones that need the user (a question, an approval, a finished job)
  const lastCcStatus = new Map<string, string>()
  claude.manager.on((event) => {
    emit({ type: 'claude', event })
    if (event.type === 'session') {
      const s = event.session
      if (lastCcStatus.get(s.id) !== s.status) {
        lastCcStatus.set(s.id, s.status)
        trace({ ev: 'cc.status', sid: agent.currentSessionId, session: s.name, status: s.status, queued: s.queued.length, costUsd: Number(s.costUsd.toFixed(4)), tokensIn: s.tokensIn, tokensOut: s.tokensOut })
      }
    } else if (event.type === 'needs-input') trace({ ev: 'cc.needs_input', sid: agent.currentSessionId, session: event.name, kind: event.pending.kind, summary: event.pending.summary.slice(0, 160) })
    else if (event.type === 'finished') trace({ ev: 'cc.finished', sid: agent.currentSessionId, session: event.name, chars: event.summary.length })
    else if (event.type === 'event' && event.event.kind === 'denied') trace({ ev: 'cc.denied', sid: agent.currentSessionId, reason: event.event.text.slice(0, 200) })
    // runbooks can react to sessions too (docs/TRIGGERS.md): a finished job with uncommitted work, a question waiting
    if (event.type === 'finished') {
      const s = claude.manager.list().find((x) => x.id === event.id)
      void changedFiles(s?.workspace).then((changed) =>
        agent.onEvent(
          'cc.finished',
          { session: event.name, sessionId: event.id, summary: event.summary.slice(0, 2000), folder: s?.workspace ?? '', mode: s?.mode ?? '', changedFiles: changed, changes: changed === null ? '' : `${changed} changed file${changed === 1 ? '' : 's'}` },
          `The Claude Code session "${event.name}" finished${changed ? ` with ${changed} changed files` : ''}: ${event.summary.slice(0, 600)}`
        )
      )
    } else if (event.type === 'needs-input') {
      agent.onEvent('cc.needs_input', { session: event.name, sessionId: event.id, kind: event.pending.kind, summary: event.pending.summary.slice(0, 600) }, `The Claude Code session "${event.name}" needs the user: ${event.pending.summary.slice(0, 600)}`)
    }
    if (!claude.enabled()) return
    const line = announcement(event)
    if (line) agent.announce(line)
  })
  // VA_SAY="one || two || three": each message is sent once the reply to the one before has finished
  if (isDev && process.env.VA_SAY) {
    const lines = process.env.VA_SAY.split(' || ').map((l) => l.trim()).filter(Boolean)
    setTimeout(() => {
      void (async () => {
        for (const [i, line] of lines.entries()) {
          // "@wait-runbook": hold the next message until a runbook is waiting for a reply (up to five minutes)
          // "@wait 20s": just wait, e.g. for a local voice to finish starting
          const pause = /^@wait (\d+)s$/.exec(line)
          if (pause) {
            await new Promise((r) => setTimeout(r, Number(pause[1]) * 1000))
            continue
          }
          if (line === '@wait-runbook') {
            for (let w = 0; w < 600 && !agent.runbooks.list().some((r) => r.status === 'waiting'); w++) await new Promise((r) => setTimeout(r, 500))
            continue
          }
          if (i > 0) {
            for (let w = 0; w < 120 && agent.busy; w++) await new Promise((r) => setTimeout(r, 500))
            await new Promise((r) => setTimeout(r, 1500))
          }
          await agent.send(line)
        }
      })()
    }, 4000)
  }
  if (isDev && process.env.VA_VIEW) {
    // switch to a rail view by its label (e.g. Diagnostics) before a VA_SCREENSHOT is taken
    setTimeout(() => {
      void win?.webContents
        .executeJavaScript(`(() => { const b = document.querySelector('button[aria-label="${process.env.VA_VIEW!.replace(/"/g, '')}"]'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`)
        .then((r) => log('devtools', `view ${process.env.VA_VIEW}: ${String(r)}`))
    }, Number(process.env.VA_VIEW_DELAY ?? 12000))
    // VA_CLICK="Review": press the first button (or role=button/tab) whose text is exactly that, else starts with it,
    // after the view opened. "A >> B" presses several, 700 ms apart.
    if (process.env.VA_CLICK) {
      process.env.VA_CLICK.split('>>').forEach((label, i) => {
        setTimeout(() => {
          const want = JSON.stringify(label.trim())
          void win?.webContents
            .executeJavaScript(
              `(() => { const all = [...document.querySelectorAll('button, [role="button"], [role="tab"]')]; const t = (e) => e.textContent.trim(); const b = all.find((e) => t(e) === ${want}) ?? all.find((e) => t(e).startsWith(${want})); if (!b) return 'not-found'; b.click(); return 'clicked' })()`
            )
            .then((r) => log('devtools', `click ${label.trim()}: ${String(r)}`))
        }, Number(process.env.VA_VIEW_DELAY ?? 12000) + 500 + i * 700)
      })
    }
    // VA_SCROLL_TO="Providers": scroll the first element whose own text is exactly that into view, after the view opened
    if (process.env.VA_SCROLL_TO) {
      setTimeout(() => {
        const want = JSON.stringify(process.env.VA_SCROLL_TO)
        void win?.webContents
          .executeJavaScript(`(() => { const el = [...document.querySelectorAll('body *')].find((e) => e.childElementCount === 0 && e.textContent.trim() === ${want}); if (!el) return 'not-found'; el.scrollIntoView({ block: 'start' }); return 'scrolled' })()`)
          .then((r) => log('devtools', `scroll to ${process.env.VA_SCROLL_TO}: ${String(r)}`))
      }, Number(process.env.VA_VIEW_DELAY ?? 12000) + 800)
    }
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
    playbooks.stop()
    training?.recorder.dispose()
    // VA_TRACE=1: print where this session's trace landed so scripted runs can pick it up
    if (process.env.VA_TRACE) console.log(`VA_TRACE ${tracePath() ?? 'none'}`)
    sidecar.stop()
    kokoro.stop()
    pocket.stop()
    searxng.stop()
    void mcp.stop()
    void claude.stop()
    store.close()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
