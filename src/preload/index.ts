import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { VoiceAgentApi } from './api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args)

const api: VoiceAgentApi = {
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch)
  },
  models: { list: () => invoke(IPC.modelsList) },
  keys: {
    status: () => invoke(IPC.keysStatus),
    set: (provider, key) => invoke(IPC.keysSet, provider, key)
  },
  chat: {
    send: (text) => invoke(IPC.chatSend, text),
    cancel: () => invoke(IPC.chatCancel),
    history: (sessionId) => invoke(IPC.chatHistory, sessionId)
  },
  voice: {
    start: () => invoke(IPC.voiceStart),
    stop: () => invoke(IPC.voiceStop),
    sendFrame: (pcm) => ipcRenderer.send(IPC.audioFrame, pcm)
  },
  training: {
    config: () => invoke(IPC.trainingConfig),
    tapStart: (info) => invoke(IPC.trainingTapStart, info),
    tapStop: () => ipcRenderer.send(IPC.trainingTapStop),
    sendFrame: (pcm) => ipcRenderer.send(IPC.trainingFrame, pcm)
  },
  speak: {
    message: (id) => invoke(IPC.speakMessage, id),
    stop: () => invoke(IPC.speakStop),
    preview: (voice, engine) => invoke(IPC.ttsPreview, voice, engine),
    catalog: (provider) => invoke(IPC.ttsCatalog, provider),
    route: () => invoke(IPC.ttsRoute),
    testRoutes: () => invoke(IPC.ttsRouteTest),
    speed: (voice) => invoke(IPC.ttsVoiceSpeed, voice),
    startKokoro: () => invoke(IPC.kokoroStart),
    voices: () => invoke(IPC.voicesList)
  },
  playback: {
    started: (turnId, seq, emittedAt) => ipcRenderer.send(IPC.playbackStarted, turnId, seq, emittedAt),
    finished: (turnId, seq) => ipcRenderer.send(IPC.playbackFinished, turnId, seq),
    cancelled: (turnId, seq, offsetS, durationS) => ipcRenderer.send(IPC.playbackCancelled, turnId, seq, offsetS, durationS),
    drained: (turnId) => ipcRenderer.send(IPC.playbackDrained, turnId)
  },
  styles: {
    list: () => invoke(IPC.stylesList),
    save: (style) => invoke(IPC.stylesSave, style),
    delete: (id) => invoke(IPC.stylesDelete, id),
    generate: (brief, base) => invoke(IPC.stylesGenerate, brief, base)
  },
  skills: {
    list: () => invoke(IPC.skillsList),
    save: (skill) => invoke(IPC.skillsSave, skill),
    delete: (id) => invoke(IPC.skillsDelete, id),
    generate: (brief) => invoke(IPC.skillsGenerate, brief)
  },
  playbooks: {
    list: () => invoke(IPC.playbooksList),
    check: (id, text) => invoke(IPC.playbooksCheck, id, text),
    save: (id, text, previousId) => invoke(IPC.playbooksSave, id, text, previousId),
    toggle: (id, on) => invoke(IPC.playbooksToggle, id, on),
    delete: (id) => invoke(IPC.playbooksDelete, id),
    test: (id, text) => invoke(IPC.playbooksTest, id, text),
    openFolder: () => invoke(IPC.playbooksOpenFolder),
    evaluate: (id, text) => invoke(IPC.playbooksEvaluate, id, text),
    label: (id, messageId, label) => invoke(IPC.playbooksLabel, id, messageId, label),
    suggest: (id, text) => invoke(IPC.playbooksSuggest, id, text)
  },
  runbooks: {
    runs: () => invoke(IPC.runbooksRuns),
    cancel: (runId) => invoke(IPC.runbooksCancel, runId)
  },
  memory: {
    scopes: () => invoke(IPC.memoryScopes),
    list: (scopeId, query) => invoke(IPC.memoryList, scopeId, query),
    upsert: (entry) => invoke(IPC.memoryUpsert, entry),
    delete: (id) => invoke(IPC.memoryDelete, id),
    confirm: (pendingId, accept) => invoke(IPC.memoryConfirm, pendingId, accept),
    history: (entryId) => invoke(IPC.memoryHistory, entryId),
    undo: (historyId, scopeId) => invoke(IPC.memoryUndo, historyId, scopeId)
  },
  projects: {
    list: () => invoke(IPC.projectsList),
    save: (project) => invoke(IPC.projectsSave, project),
    delete: (id) => invoke(IPC.projectsDelete, id)
  },
  sessions: {
    list: () => invoke(IPC.sessionsList),
    new: () => invoke(IPC.sessionsNew),
    select: (id) => invoke(IPC.sessionsSelect, id),
    delete: (id) => invoke(IPC.sessionsDelete, id)
  },
  services: {
    status: () => invoke(IPC.servicesStatus),
    mcpStatus: () => invoke(IPC.mcpStatus),
    mcpReload: () => invoke(IPC.mcpReload),
    mcpTestTool: (server, tool, input) => invoke(IPC.mcpTestTool, server, tool, input),
    mcpConfig: () => invoke(IPC.mcpConfig),
    mcpSetConfig: (servers) => invoke(IPC.mcpSetConfig, servers),
    searxngEnsure: () => invoke(IPC.searxngEnsure),
    sidecarRestart: () => invoke(IPC.sidecarRestart)
  },
  claude: {
    list: () => invoke(IPC.claudeList),
    events: (id, n) => invoke(IPC.claudeEvents, id, n),
    start: (name, task, folder, mode) => invoke(IPC.claudeStart, name, task, folder, mode),
    send: (id, text, now) => invoke(IPC.claudeSend, id, text, now),
    answer: (id, answer) => invoke(IPC.claudeAnswer, id, answer),
    interrupt: (id, clearQueue) => invoke(IPC.claudeInterrupt, id, clearQueue),
    stop: (id) => invoke(IPC.claudeStop, id),
    dequeue: (id, index) => invoke(IPC.claudeDequeue, id, index),
    setMode: (id, mode) => invoke(IPC.claudeSetMode, id, mode),
    rename: (id, name) => invoke(IPC.claudeRename, id, name),
    reset: (id) => invoke(IPC.claudeReset, id),
    remove: (id, deleteFolder) => invoke(IPC.claudeRemove, id, deleteFolder),
    files: (id) => invoke(IPC.claudeFiles, id),
    read: (id, rel) => invoke(IPC.claudeRead, id, rel),
    write: (id, rel, text, expectedMtime) => invoke(IPC.claudeWrite, id, rel, text, expectedMtime),
    open: (id, rel, how) => invoke(IPC.claudeOpen, id, rel, how),
    external: () => invoke(IPC.claudeExternal),
    externalEvents: (sessionId, cwd) => invoke(IPC.claudeExternalEvents, sessionId, cwd),
    attach: (x) => invoke(IPC.claudeAttach, x),
    folders: () => invoke(IPC.claudeFolders),
    pickFolder: () => invoke(IPC.claudePickFolder),
    account: (fresh) => invoke(IPC.claudeAccount, fresh)
  },
  explore: {
    pickFolder: () => invoke(IPC.explorePickFolder),
    check: (path) => invoke(IPC.exploreCheck, path)
  },
  diagrams: {
    list: () => invoke(IPC.diagramsList),
    get: (id) => invoke(IPC.diagramsGet, id),
    save: (id, x) => invoke(IPC.diagramsSave, id, x),
    create: (x) => invoke(IPC.diagramsCreate, x),
    remove: (id) => invoke(IPC.diagramsDelete, id),
    onCheck: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, id: string, code: string): void => {
        void handler(code).then(
          (r) => ipcRenderer.send(IPC.diagramChecked, id, r),
          () => ipcRenderer.send(IPC.diagramChecked, id, null)
        )
      }
      ipcRenderer.on(IPC.diagramCheck, listener)
      return () => ipcRenderer.removeListener(IPC.diagramCheck, listener)
    }
  },
  context: { snapshot: () => invoke(IPC.contextSnapshot) },
  shell: { open: (url) => invoke(IPC.openExternal, url) },
  log: { write: (level, scope, msg) => ipcRenderer.send(IPC.logWrite, level, scope, msg) },
  diag: {
    logs: () => invoke(IPC.logsList),
    tail: (name, lines) => invoke(IPC.logsTail, name, lines),
    openLogsFolder: () => invoke(IPC.logsOpenFolder),
    report: () => invoke(IPC.diagReport),
    analysis: () => invoke(IPC.diagAnalysis),
    suggest: () => invoke(IPC.diagSuggest),
    trace: (sessionId, limit) => invoke(IPC.traceSession, sessionId, limit),
    lastTurn: () => invoke(IPC.traceLastTurn),
    summary: () => invoke(IPC.sessionSummary)
  },
  console: {
    history: () => invoke(IPC.consoleHistory),
    onEntries: (handler) => {
      const listener = (_e: Electron.IpcRendererEvent, entries: Parameters<typeof handler>[0]) => handler(entries)
      ipcRenderer.on(IPC.consoleEntries, listener)
      return () => ipcRenderer.removeListener(IPC.consoleEntries, listener)
    }
  },
  onEvent: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, event: Parameters<typeof handler>[0]) => handler(event)
    ipcRenderer.on(IPC.event, listener)
    return () => ipcRenderer.removeListener(IPC.event, listener)
  },
  onAudioChunk: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, chunk: Parameters<typeof handler>[0]) => handler(chunk)
    ipcRenderer.on(IPC.audioChunk, listener)
    return () => ipcRenderer.removeListener(IPC.audioChunk, listener)
  },
  onAudioCancel: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, turnId: string | null) => handler(turnId)
    ipcRenderer.on(IPC.audioCancel, listener)
    return () => ipcRenderer.removeListener(IPC.audioCancel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
