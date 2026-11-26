import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { checkRoot } from '@core/explore/roots'
import { generateText } from 'ai'
import { IPC } from '@shared/ipc'
import type { CloudTtsProvider, KeyName, LogLevel, PlaybookLabel, McpServerConfig, MemoryEntry, Project, PromptStyle, Provider, ServiceStatus, Settings, Skill, StyleDraft, TtsEngineId } from '@shared/types'
import type { Agent } from '@core/agent'
import { MODELS, findModel } from '@core/providers/models'
import { resolveModel } from '@core/providers/resolve'
import { withProjectDefaults } from '@core/projects'
import type { EdgeRouteService } from '../services/edgeRoute'
import { BUILTIN_STYLES } from '@core/prompts/styles'
import { ModelFactory } from '@core/providers/factory'
import type { MemoryStore } from '@core/memory/store'
import type { SettingsService } from '../services/settings'
import type { SidecarService } from '../services/sidecar'
import type { SearxngService } from '../services/searxng'
import type { McpService } from '../services/mcp'
import type { ClaudeService } from '../services/claude'
import type { DiagramService } from '../services/diagrams'
import type { PlaybookService } from '../services/playbooks'
import type { PlaybookReview } from '../services/playbookReview'
import { testPlaybook } from '@core/playbooks/test-run'
import type { JevClient } from '@core/jev/client'
import type { DiagramCheck } from '@shared/diagram'
import { CC_MODES, type CcAnswer, type CcMode } from '@shared/claude'
import { consoleHistory, log, logAt } from '../services/log'
import { diagnosticsReport, lastTurn, listLogs, openLogsFolder, readTrace, sessionAnalysis, suggestTuning, tailLog } from '../services/diagnostics'

const LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])

export interface IpcDeps {
  win: () => BrowserWindow | null
  agent: Agent
  store: MemoryStore
  settings: SettingsService
  sidecar: SidecarService
  searxng: SearxngService
  mcp: McpService
  claude: ClaudeService
  diagrams: DiagramService
  playbooks: PlaybookService
  review: PlaybookReview
  jev: JevClient
  services: () => ServiceStatus[]
  edgeRoute: EdgeRouteService
  kokoro: { start(opts?: { force?: boolean }): Promise<boolean> }
  pocket: { start(opts?: { force?: boolean }): Promise<boolean> }
  broadcastSettings(s: Settings): void
}

const STYLE_DRAFT_PROMPT = `You write system prompts for a spoken voice assistant. Given a short brief, produce a JSON object with keys "label" (2-3 words), "desc" (one sentence, under 90 characters) and "body" (the system prompt: 3-6 sentences, second person, about how the assistant should talk and behave; remember the text is spoken aloud, so mention sentence length and no reading of code or markdown when relevant). Output only the JSON.`

const STYLE_REFINE_PROMPT = `You edit system prompts for a spoken voice assistant. You are given the CURRENT prompt and an INSTRUCTION describing what to change. Rewrite the prompt applying the instruction while keeping everything else intact (same voice, same length, second person). Produce a JSON object with keys "label" (keep the current label unless the instruction changes the character), "desc" (one sentence, under 90 characters) and "body" (the rewritten prompt). Output only the JSON.`

const SKILL_DRAFT_PROMPT = `You write "skills" for a voice assistant: short reusable procedures for a kind of situation. Given a brief, produce a JSON object with keys "name" (2-4 words), "trigger" (one sentence starting with "When", describing when this applies) and "procedure" (2-4 sentences, imperative, concrete; the assistant reads this before acting). Output only the JSON.`

const parseJson = <T>(text: string): T | null => {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

export function registerIpc(d: IpcDeps): void {
  const h = ipcMain.handle.bind(ipcMain)

  h(IPC.settingsGet, () => d.settings.get())
  h(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    const s = d.settings.set(withProjectDefaults(patch, d.settings.get(), d.store.projects()))
    d.broadcastSettings(s)
    return s
  })
  h(IPC.modelsList, () => MODELS)
  h(IPC.keysStatus, () => d.settings.keyStatus())
  h(IPC.keysSet, (_e, provider: KeyName, key: string) => d.settings.setKey(provider, key))

  h(IPC.chatSend, (_e, text: string) => d.agent.send(text))
  h(IPC.chatCancel, () => d.agent.cancel())
  h(IPC.chatHistory, (_e, sessionId?: string) => d.agent.history(sessionId))

  h(IPC.voiceStart, () => {
    d.sidecar.setListening(true)
    d.agent.setMic(true)
  })
  h(IPC.voiceStop, () => {
    d.sidecar.setListening(false)
    d.agent.setMic(false)
  })
  ipcMain.on(IPC.audioFrame, (_e, pcm: ArrayBuffer) => d.sidecar.sendFrame(pcm))
  ipcMain.on(IPC.logWrite, (_e, level: LogLevel, scope: string, msg: string) => {
    if (LEVELS.has(level) && typeof msg === 'string') logAt(level, `renderer:${String(scope).slice(0, 32)}`, msg.slice(0, 2000))
  })

  h(IPC.speakMessage, (_e, id: string) => d.agent.speakMessage(id))
  h(IPC.speakStop, () => d.agent.stopReading())
  h(IPC.ttsPreview, (_e, voice: string, engine?: TtsEngineId) => d.agent.preview(voice, engine))
  h(IPC.ttsCatalog, (_e, provider: CloudTtsProvider) => d.agent.catalog(provider))
  h(IPC.ttsRoute, () => d.edgeRoute.state())
  h(IPC.ttsRouteTest, () => d.edgeRoute.retestAll())
  h(IPC.ttsVoiceSpeed, (_e, voice: string) => d.agent.voiceSpeed(String(voice)))
  h(IPC.kokoroStart, () => d.kokoro.start({ force: true }))
  h(IPC.pocketStart, () => d.pocket.start({ force: true }))
  h(IPC.voicesList, () => d.agent.voices())

  ipcMain.on(IPC.playbackStarted, (_e, turnId: string, seq: number, emittedAt?: number) => d.agent.onPlaybackStarted(turnId, seq, typeof emittedAt === 'number' ? emittedAt : undefined))
  ipcMain.on(IPC.playbackFinished, (_e, turnId: string, seq: number) => d.agent.onPlaybackFinished(turnId, seq))
  ipcMain.on(IPC.playbackCancelled, (_e, turnId: string, seq: number, offsetS: number, durationS: number) => d.agent.onPlaybackCancelled(turnId, seq, offsetS, durationS))
  ipcMain.on(IPC.playbackDrained, (_e, turnId: string) => d.agent.onPlaybackDrained(turnId))

  const allStyles = (): PromptStyle[] => [...BUILTIN_STYLES, ...d.settings.styles()]
  h(IPC.stylesList, () => allStyles())
  h(IPC.stylesSave, (_e, style: PromptStyle) => {
    d.settings.saveStyle(style)
    return allStyles()
  })
  h(IPC.stylesDelete, (_e, id: string) => {
    d.settings.deleteStyle(id)
    return allStyles()
  })
  // drafting styles/skills uses the same model a turn would: the configured one, or one whose provider has a key
  const draftModel = () => new ModelFactory(d.settings).create(resolveModel(d.settings.get().modelId, d.settings)?.model ?? findModel(d.settings.get().modelId) ?? MODELS[0]!).model
  h(IPC.stylesGenerate, async (_e, brief: string, base?: { label: string; body: string }): Promise<StyleDraft> => {
    const prompt = base ? `CURRENT LABEL: ${base.label}\nCURRENT PROMPT:\n${base.body}\n\nINSTRUCTION: ${brief}` : brief
    const { text } = await generateText({ model: draftModel(), system: base ? STYLE_REFINE_PROMPT : STYLE_DRAFT_PROMPT, prompt, abortSignal: AbortSignal.timeout(30_000) })
    const parsed = parseJson<Partial<StyleDraft>>(text)
    return { label: parsed?.label ?? base?.label ?? 'New style', desc: parsed?.desc ?? brief, body: parsed?.body ?? text }
  })

  const skillsChanged = (skills: Skill[]): Skill[] => {
    d.win()?.webContents.send(IPC.event, { type: 'skills-changed' })
    return skills
  }
  h(IPC.playbooksList, () => d.playbooks.state())
  h(IPC.playbooksCheck, (_e, id: string, text: string) => d.playbooks.check(String(id), String(text)))
  h(IPC.playbooksSave, (_e, id: string, text: string, previousId?: string) => d.playbooks.save(String(id), String(text), previousId ? String(previousId) : undefined))
  h(IPC.playbooksToggle, (_e, id: string, on: boolean) => d.playbooks.toggle(String(id), !!on))
  h(IPC.playbooksDelete, (_e, id: string) => d.playbooks.delete(String(id)))
  // the last 40 things the user said or typed, newest first, against the draft in the editor
  h(IPC.playbooksTest, (_e, id: string, text: string) => {
    const t = d.settings.get().playbooks
    return testPlaybook(String(id), String(text), d.store.recentUserMessages(40), { ...t }, t.useJev ? { client: d.jev, timeoutMs: t.jevTimeoutMs, intentMin: t.intentMin } : undefined)
  })
  h(IPC.playbooksEvaluate, (_e, id: string, text?: string) => d.review.evaluate(String(id), typeof text === 'string' ? text : undefined))
  h(IPC.playbooksLabel, (_e, id: string, messageId: string, label: PlaybookLabel | null) => d.review.label(String(id), String(messageId), label === 'should' || label === 'should_not' ? label : null))
  h(IPC.playbooksSuggest, (_e, id: string, text?: string) => d.review.suggest(String(id), typeof text === 'string' ? text : undefined))
  h(IPC.runbooksRuns, () => d.agent.runbooks.list())
  h(IPC.runbooksCancel, (_e, runId: string) => d.agent.runbooks.cancel(String(runId)))
  h(IPC.playbooksOpenFolder, async () => {
    await shell.openPath(d.playbooks.dir)
  })
  h(IPC.skillsList, () => d.settings.skills())
  h(IPC.skillsSave, (_e, skill: Skill) => skillsChanged(d.settings.saveSkill(skill)))
  h(IPC.skillsDelete, (_e, id: string) => skillsChanged(d.settings.deleteSkill(id)))
  h(IPC.skillsGenerate, async (_e, brief: string) => {
    const { text } = await generateText({ model: draftModel(), system: SKILL_DRAFT_PROMPT, prompt: brief, abortSignal: AbortSignal.timeout(30_000) })
    const parsed = parseJson<{ name?: string; trigger?: string; procedure?: string }>(text)
    return { name: parsed?.name ?? 'New skill', trigger: parsed?.trigger ?? `When ${brief}`, procedure: parsed?.procedure ?? text }
  })

  h(IPC.memoryScopes, () => d.store.scopes())
  h(IPC.memoryList, (_e, scopeId: string, query?: string) => d.store.list(scopeId, query))
  h(IPC.memoryUpsert, (_e, entry: Partial<MemoryEntry> & { scopeId: string; key: string; value: string }) => {
    const saved = d.store.upsert({ ...entry, source: 'ui' })
    d.win()?.webContents.send(IPC.event, { type: 'memory-changed' })
    return saved
  })
  h(IPC.memoryDelete, (_e, id: number) => {
    d.store.delete(id)
    d.win()?.webContents.send(IPC.event, { type: 'memory-changed' })
  })
  h(IPC.memoryConfirm, (_e, pendingId: string, accept: boolean) => d.agent.confirmPending(pendingId, accept))
  h(IPC.memoryHistory, (_e, entryId: number) => d.store.history(entryId))
  h(IPC.memoryUndo, (_e, historyId: number, scopeId?: string) => {
    const entry = d.store.undo(historyId, scopeId)
    d.win()?.webContents.send(IPC.event, { type: 'memory-changed' })
    return entry
  })

  h(IPC.projectsList, () => d.store.projects())
  h(IPC.projectsSave, (_e, project: Project) => {
    d.store.saveProject(project)
    return d.store.projects()
  })
  h(IPC.projectsDelete, (_e, id: string) => {
    d.store.deleteProject(id)
    if (d.settings.get().projectId === id) d.broadcastSettings(d.settings.set({ projectId: 'global' }))
    return d.store.projects()
  })

  h(IPC.sessionsList, () => d.store.sessions())
  h(IPC.sessionsNew, () => d.agent.newSession())
  h(IPC.sessionsSelect, (_e, id: string) => d.agent.selectSession(id))
  h(IPC.sessionsDelete, (_e, id: string) => {
    d.agent.deleteSession(id)
    return d.store.sessions()
  })

  h(IPC.servicesStatus, () => d.services())
  h(IPC.claudeList, () => d.claude.manager.list())
  h(IPC.claudeEvents, (_e, id: string, n?: number) => d.claude.manager.events(id, n))
  h(IPC.claudeStart, (_e, name: string, task?: string, folder?: string, mode?: CcMode) => d.claude.manager.start(name, task, { folder, mode: mode && CC_MODES.includes(mode) ? mode : undefined }))
  h(IPC.claudeSend, (_e, id: string, text: string, now?: boolean) => d.claude.manager.send(id, text, { now: !!now }))
  h(IPC.claudeAnswer, (_e, id: string, answer: CcAnswer) => d.claude.manager.answer(id, answer))
  h(IPC.claudeInterrupt, (_e, id: string, clearQueue?: boolean) => d.claude.manager.interrupt(id, { clearQueue: !!clearQueue }))
  h(IPC.claudeStop, (_e, id: string) => d.claude.manager.stop(id))
  h(IPC.claudeDequeue, (_e, id: string, index: number) => d.claude.manager.dequeue(id, index))
  h(IPC.claudeSetMode, (_e, id: string, mode: CcMode) => (CC_MODES.includes(mode) ? d.claude.manager.setMode(id, mode) : { ok: false, error: 'Unknown mode.' }))
  h(IPC.claudeRename, (_e, id: string, name: string) => d.claude.manager.rename(id, name))
  h(IPC.claudeReset, (_e, id: string) => d.claude.manager.reset(id))
  h(IPC.claudeCompact, (_e, id: string, focus?: string) => d.claude.manager.compact(id, focus ?? ''))
  h(IPC.claudeRemove, (_e, id: string, deleteFolder?: boolean) => d.claude.manager.remove(id, { deleteFolder: !!deleteFolder }))
  h(IPC.claudeFolders, () => d.claude.manager.folders())
  h(IPC.claudePickFolder, () => d.claude.pickFolder())
  h(IPC.claudeAccount, (_e, fresh?: boolean) => d.claude.account(!!fresh))
  h(IPC.explorePickFolder, async () => {
    const win = d.win()
    const opts = { title: 'Choose a folder the assistant may read', properties: ['openDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  h(IPC.exploreCheck, (_e, p: string) => checkRoot(String(p ?? '')))
  h(IPC.claudeFiles, (_e, id: string) => d.claude.manager.files(id))
  h(IPC.claudeRead, (_e, id: string, rel: string) => d.claude.manager.readFile(id, rel))
  h(IPC.claudeWrite, (_e, id: string, rel: string, text: string, expectedMtime?: number) => d.claude.manager.writeFile(id, rel, text, expectedMtime))
  h(IPC.claudeExternal, () => d.claude.manager.external())

  h(IPC.diagramsList, () => d.diagrams.library.list())
  h(IPC.diagramsGet, (_e, id: string) => d.diagrams.library.get(id) ?? null)
  // the owner's own edits: a new version, never a replacement
  h(IPC.diagramsSave, (_e, id: string, x: { code?: string; title?: string; note?: string }) => d.diagrams.library.commit(id, { ...x, by: 'user' })?.doc ?? null)
  h(IPC.diagramsCreate, (_e, x: { title: string; code: string }) => d.diagrams.library.create({ ...x, by: 'user', sessionId: d.agent.currentSessionId }))
  h(IPC.diagramsDelete, (_e, id: string) => d.diagrams.library.remove(id))
  ipcMain.on(IPC.diagramChecked, (_e, id: string, result: DiagramCheck | null) => d.diagrams.checked(id, result))
  h(IPC.claudeExternalEvents, (_e, sessionId: string, cwd?: string) => d.claude.manager.externalEvents(sessionId, cwd))
  h(IPC.claudeAttach, (_e, x: { sessionId: string; title: string; cwd: string }) => d.claude.manager.attach(x))
  h(IPC.claudeOpen, (_e, id: string, rel: string, how: 'default' | 'reveal' | 'code') => d.claude.open(id, rel, how))
  h(IPC.mcpStatus, () => d.mcp.statuses())
  h(IPC.mcpReload, () => d.mcp.reload())
  h(IPC.mcpConfig, () => d.mcp.config())
  h(IPC.mcpSetConfig, async (_e, servers: McpServerConfig[]) => {
    const statuses = await d.mcp.setConfig(servers)
    d.win()?.webContents.send(IPC.event, { type: 'mcp-changed' })
    return statuses
  })
  h(IPC.mcpTestTool, async (_e, server: string, tool: string, input: unknown) => {
    try {
      return await d.mcp.call(server, tool, (input ?? {}) as Record<string, unknown>, AbortSignal.timeout(30_000))
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  h(IPC.searxngEnsure, async () => {
    await d.searxng.ensure()
    return d.searxng.status
  })
  h(IPC.sidecarRestart, () => d.sidecar.restart())
  h(IPC.contextSnapshot, () => d.agent.snapshot())
  h(IPC.consoleHistory, () => consoleHistory())
  h(IPC.logsList, () => listLogs())
  h(IPC.logsTail, (_e, name: string, lines?: number) => tailLog(String(name), lines))
  h(IPC.logsOpenFolder, () => openLogsFolder())
  h(IPC.diagReport, () => diagnosticsReport({ agent: d.agent, settings: () => d.settings.get(), services: d.services }))
  h(IPC.diagAnalysis, () => sessionAnalysis(d.agent.currentSessionId))
  h(IPC.diagSuggest, () => suggestTuning({ agent: d.agent, settings: () => d.settings.get(), services: d.services, keys: d.settings }))
  h(IPC.traceSession, (_e, sessionId?: string | null, limit?: number) => readTrace(sessionId ?? d.agent.currentSessionId, limit))
  h(IPC.traceLastTurn, () => lastTurn(d.agent.currentSessionId))
  h(IPC.sessionSummary, () => d.agent.summary())
  h(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    log('ipc', `refused to open ${url}`)
    return Promise.resolve()
  })
}
