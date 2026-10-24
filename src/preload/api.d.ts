import type { CcAccount, CcAnswer, CcEvent, CcExternal, CcFile, CcFileContent, CcResult, CcSession } from '@shared/claude'
import type {
  AgentEvent,
  AudioChunk,
  ChatMessage,
  ContextSnapshot,
  KeyStatus,
  LogFileInfo,
  LogLevel,
  McpServerConfig,
  McpServerStatus,
  Skill,
  StyleDraft,
  MemoryEntry,
  MemoryHistoryEntry,
  MemoryScope,
  ModelInfo,
  Project,
  PromptStyle,
  Provider,
  ServiceStatus,
  Session,
  SessionAnalysis,
  SessionSummary,
  Settings,
  TraceEvent,
  TuningSuggestion,
  VoiceInfo
} from '../shared/types'

export interface VoiceAgentApi {
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  models: { list(): Promise<ModelInfo[]> }
  keys: {
    status(): Promise<KeyStatus[]>
    set(provider: Provider, key: string): Promise<KeyStatus[]>
  }
  chat: {
    send(text: string): Promise<void>
    cancel(): Promise<void>
    history(sessionId?: string): Promise<ChatMessage[]>
  }
  voice: {
    start(): Promise<void>
    stop(): Promise<void>
    sendFrame(pcm: ArrayBuffer): void
  }
  /** Training recording mode (RECORD_TRAINING_DATA=1): a raw, unprocessed copy of the mic. */
  training: {
    config(): Promise<{ enabled: boolean }>
    tapStart(info: { sampleRate: number; device: string; processing: Record<string, unknown> }): Promise<void>
    tapStop(): void
    /** Float32 mono samples at the tap's native rate. */
    sendFrame(pcm: ArrayBuffer): void
  }
  speak: {
    message(messageId: string): Promise<void>
    stop(): Promise<void>
    preview(voice: string): Promise<void>
    voices(): Promise<VoiceInfo[]>
  }
  playback: {
    /** `emittedAt` is the chunk's main-process emit time, echoed back so main can time the renderer stage. */
    started(turnId: string, seq: number, emittedAt?: number): void
    finished(turnId: string, seq: number): void
    /** The chunk that was playing when the turn was cancelled, and how far into it the cut landed. */
    cancelled(turnId: string, seq: number, offsetS: number, durationS: number): void
    drained(turnId: string): void
  }
  styles: {
    list(): Promise<PromptStyle[]>
    save(style: PromptStyle): Promise<PromptStyle[]>
    delete(id: string): Promise<PromptStyle[]>
    /** Draft a new style from a brief, or — when `base` is given — rewrite that existing prompt body per the brief. */
    generate(brief: string, base?: { label: string; body: string }): Promise<StyleDraft>
  }
  skills: {
    list(): Promise<Skill[]>
    save(skill: Skill): Promise<Skill[]>
    delete(id: string): Promise<Skill[]>
    generate(brief: string): Promise<{ name: string; trigger: string; procedure: string }>
  }
  memory: {
    scopes(): Promise<MemoryScope[]>
    list(scopeId: string, query?: string): Promise<MemoryEntry[]>
    upsert(entry: Partial<MemoryEntry> & { scopeId: string; key: string; value: string }): Promise<MemoryEntry>
    delete(id: number): Promise<void>
    confirm(pendingId: string, accept: boolean): Promise<void>
    history(entryId: number): Promise<MemoryHistoryEntry[]>
    /** Restore the entry to its state before that history row (re-creating it in `scopeId` if it was deleted). */
    undo(historyId: number, scopeId?: string): Promise<MemoryEntry | undefined>
  }
  projects: {
    list(): Promise<Project[]>
    save(project: Project): Promise<Project[]>
    delete(id: string): Promise<Project[]>
  }
  sessions: {
    list(): Promise<Session[]>
    new: () => Promise<Session>
    select(id: string): Promise<ChatMessage[]>
    delete(id: string): Promise<Session[]>
  }
  services: {
    status(): Promise<ServiceStatus[]>
    mcpStatus(): Promise<McpServerStatus[]>
    mcpReload(): Promise<McpServerStatus[]>
    mcpTestTool(server: string, tool: string, input: unknown): Promise<unknown>
    mcpConfig(): Promise<McpServerConfig[]>
    /** Persists the full server list to the user-data mcp.json and reconnects. */
    mcpSetConfig(servers: McpServerConfig[]): Promise<McpServerStatus[]>
    searxngEnsure(): Promise<ServiceStatus>
    sidecarRestart(): Promise<void>
  }
  /** Claude Code sessions managed by the voice agent. Live changes arrive as `{type:'claude'}` events. */
  claude: {
    list(): Promise<CcSession[]>
    events(id: string, n?: number): Promise<CcEvent[]>
    /** `folder`: a workspace folder name to reuse, or a full project path (works in your real files). */
    start(name: string, task?: string, folder?: string): Promise<CcResult<{ session: CcSession }>>
    send(id: string, text: string, now?: boolean): Promise<CcResult<{ queued: boolean }>>
    answer(id: string, answer: CcAnswer): Promise<CcResult<{ said: string }>>
    interrupt(id: string, clearQueue?: boolean): Promise<CcResult>
    stop(id: string): Promise<CcResult>
    dequeue(id: string, index: number): Promise<CcResult>
    rename(id: string, name: string): Promise<CcResult>
    /** Fresh start: forget the conversation, keep the folder. */
    reset(id: string): Promise<CcResult>
    /** Drop from the list; the folder stays on disk unless `deleteFolder` (sandbox folders only). */
    remove(id: string, deleteFolder?: boolean): Promise<CcResult<{ deletedFolder?: string }>>
    files(id: string): Promise<CcFile[]>
    read(id: string, rel: string): Promise<CcFileContent | { error: string }>
    /** Open the workspace (rel '') or a file in it: default app, Explorer, or VS Code. */
    open(id: string, rel: string, how: 'default' | 'reveal' | 'code'): Promise<CcResult>
    /** Your other saved Claude Code sessions on this machine, newest first. */
    external(): Promise<CcExternal[]>
    externalEvents(sessionId: string, cwd?: string): Promise<CcEvent[]>
    /** Continue a saved session here (forks it; works in its own project folder). */
    attach(x: { sessionId: string; title: string; cwd: string }): Promise<CcResult<{ session: CcSession }>>
    /** Folders directly under the workspace root, newest first. */
    folders(): Promise<Array<{ name: string; path: string; mtime: number; inUse: boolean }>>
    /** Native folder picker; null when cancelled. */
    pickFolder(): Promise<string | null>
    /** Who sessions run as (asked of the CLI, no usage); `fresh` skips the cached answer. */
    account(fresh?: boolean): Promise<CcAccount>
  }
  context: { snapshot(): Promise<ContextSnapshot> }
  shell: { open(url: string): Promise<void> }
  /** Renderer log lines land in the main process log files (through the same flood guard). */
  log: { write(level: LogLevel, scope: string, msg: string): void }
  diag: {
    logs(): Promise<LogFileInfo[]>
    tail(name: string, lines?: number): Promise<string[]>
    openLogsFolder(): Promise<void>
    /** Markdown report: setup, services, tuning diff, session summary, last turn timeline, recent errors. */
    report(): Promise<string>
    /** Turn-taking statistics for the current session, computed from its trace. */
    analysis(): Promise<SessionAnalysis>
    /** Ask the current model for tuning changes justified by the analysis. */
    suggest(): Promise<{ suggestions: TuningSuggestion[]; analysis: SessionAnalysis; model: string; raw?: string }>
    trace(sessionId?: string | null, limit?: number): Promise<TraceEvent[]>
    lastTurn(): Promise<TraceEvent[]>
    summary(): Promise<SessionSummary>
  }
  onEvent(handler: (event: AgentEvent) => void): () => void
  onAudioChunk(handler: (chunk: AudioChunk) => void): () => void
  onAudioCancel(handler: (turnId: string | null) => void): () => void
}

declare global {
  interface Window {
    api: VoiceAgentApi
  }
}
