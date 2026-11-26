// Shared contracts between main, preload, renderer and the agent core.
// Everything crossing an IPC boundary is defined here.

import type { DiagramDoc } from './diagram'
import type { CcManagerEvent, CcMode } from './claude'
import type { TuningValues } from './tuning'

export type Provider = 'anthropic' | 'openai' | 'groq' | 'google' | 'xai'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ModelInfo {
  id: string
  provider: Provider
  providerLabel: string
  model: string
  label: string
  note?: string
  fast?: boolean
  /** Reasoning model: the reasoning-effort tuning applies. */
  reasoning?: boolean
  /** Claude model that takes `effort` (thinks adaptively by default): the Claude effort tuning applies. */
  effort?: boolean
}

export type Mode = 'ask' | 'agent'

export type AgentState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'thinking'
  | 'tool'
  | 'speaking'
  | 'interrupted'

export type ServiceName = 'sidecar' | 'searxng' | 'mcp' | 'tts' | 'llm' | 'claude'
export type ServiceState = 'off' | 'starting' | 'ready' | 'error' | 'reconnecting'

export interface ServiceStatus {
  name: ServiceName
  state: ServiceState
  detail?: string
}

export type StyleLength = 'short' | 'balanced' | 'comprehensive'
export type StyleFormat = 'plain' | 'markdown'

export interface PromptStyle {
  id: string
  label: string
  desc: string
  kind: 'built-in' | 'custom'
  body: string
  length: StyleLength
  format: StyleFormat
}

export type ToolStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ToolSource {
  title: string
  url: string
  snippet?: string
}

export interface ToolActivity {
  name: string
  label: string
  kind: 'search' | 'read' | 'memory' | 'mcp' | 'time' | 'claude' | 'diagram' | 'files' | 'other'
  status: ToolStatus
  startedAt: number
  endedAt?: number
  /** One line describing what the tool is doing, e.g. the search query or the URL being read. */
  summary?: string
  /** Human-readable outcome, e.g. "6 results" or "saved". */
  detail?: string
  sources?: ToolSource[]
  server?: string
  /** The call's arguments, kept so the call can be replayed into the model's history. */
  input?: unknown
  /** Compacted result text kept in history for later turns (see brain.toolResultKeepChars). */
  resultText?: string
  /** Before/after of a memory edit, shown as a diff under the pill. */
  diff?: { before: string; after: string }
  /** The diagram this call drew or changed, and the version it produced: the chat shows it under the pill. */
  diagram?: { id: string; version: number }
}

export interface TurnMetrics {
  /** Final ASR decode time reported by the ears. */
  asrMs?: number
  /** Time the utterance waited for the decoder. */
  queuedMs?: number
  /** Turn start (final transcript received) -> first token. */
  ttftMs?: number
  /** Turn start -> first complete sentence handed to TTS. */
  ttfsMs?: number
  /** Synthesis time of the first sentence (request -> full audio). */
  ttsFirstMs?: number
  /** Edge TTS request -> first audio byte for the first sentence. */
  ttsFirstByteMs?: number
  /** Turn start -> first audio playing. */
  ttfaMs?: number
  /** First chunk leaving the agent -> the renderer starting it (IPC + decode + scheduling). Over ~150 ms means the UI is too busy. */
  rendererMs?: number
  /** End of the user's speech -> first audio playing: the number humans feel. Voice turns only. */
  speechEndToAudioMs?: number
  totalMs?: number
  model?: string
  /** The whole prompt across every model call of the turn, cached parts included. */
  inputTokens?: number
  outputTokens?: number
  /** Of `inputTokens`: served from the prompt cache (about a tenth of the price) and written to it. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** List-price dollars for the turn; absent when a model without a known price took part. */
  costUsd?: number
  steps?: number
  /** Why the ears closed the turn, and the Smart Turn score that did it. */
  endReason?: 'done' | 'timeout'
  silenceMs?: number
  speechMs?: number
  turnP?: number | null
  interrupted?: boolean
  spokenChars?: number
  unspokenChars?: number
  fillers?: number
  stallReason?: string
  fallbackUsed?: boolean
  hitStepLimit?: boolean
}

/** One line of the session trace (logs/sessions/<sid>.jsonl); vocabulary in docs/DEBUGGING.md. */
export interface TraceEvent {
  /** Dotted event name: state, ear.final, turn.start, tts.sentence, playback.started, sidecar.ready … */
  ev: string
  /** Session the event belongs to; omitted for process-level events, which land in the current session. */
  sid?: string
  turn?: string
  t?: string
  [key: string]: unknown
}

/** Turn-taking statistics computed from a session trace (the numbers a tuner needs). */
export interface SessionAnalysis {
  events: number
  spanMin: number
  turns: number
  voiceTurns: number
  endReasons: { done: number; timeout: number }
  /** Timeouts by the cap that fired: keys are the cap in ms, or 'unknown'. */
  timeoutsByCap: Record<string, number>
  doneAtFirstCheck: number
  fillerHolds: number
  /** Last partial word at the check that ended a turn by timeout, most frequent first. */
  timeoutLastWords: Array<[string, number]>
  turnP: { low: number; mid: number; high: number; confident: number }
  mergeable: number
  continuations: number
  merged: number
  segments: number
  cancels: { newInput: number; bargeIn: number; continuation: number; other: number }
  bargein: { duck: number; cut: number; release: number }
  selfCutSuspects: number
  dropped: number
  stalls: number
  fallbacks: number
  stepLimits: number
  noteEchoes: number
  asrFailures: number
  asrReloads: number
  gpuMiB: number | null
  crashes: number
  /** Interrupted replies replayed without a model call, by what triggered it. */
  resumes: { resume: number; backchannel: number; empty: number }
  /** Tuning keys whose superseded default was replaced at load (`group.key old→new`). */
  migratedDefaults: string[]
  latency: SessionSummary['latency']
}

export interface TuningSuggestion {
  group: string
  key: string
  value: number | boolean | string
  current: number | boolean | string
  reason: string
}

export interface LogFileInfo {
  /** File name, with a `sessions/` prefix for per-session traces. */
  name: string
  bytes: number
  modifiedAt: number
}

export interface SessionSummary {
  turns: number
  voiceTurns: number
  interrupted: number
  fallbacks: number
  stalls: number
  stepLimits: number
  fillers: number
  latency: Partial<Record<'asrMs' | 'ttftMs' | 'ttfsMs' | 'ttsFirstMs' | 'rendererMs' | 'ttfaMs' | 'speechEndToAudioMs' | 'totalMs', { p50: number; p95: number; n: number }>>
}

export interface Skill {
  id: string
  name: string
  trigger: string
  procedure: string
  enabled: boolean
  kind: 'built-in' | 'custom'
}

export interface McpServerConfig {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
}

/** How the ears closed a user's turn; drawn as chips on the user bubble. */
export interface UserTiming {
  speechMs?: number
  silenceMs?: number
  endReason?: 'done' | 'timeout'
  turnP?: number | null
  /** Which silence/utterance cap fired on a timeout. */
  capMs?: number | null
  /** This turn was assembled from a fragment plus what the user said next. */
  merged?: boolean
  parts?: number
  /** Long-utterance segments transcribed before the final tail. */
  segments?: number
  /** This utterance interrupted the agent (barge-in cut). */
  cutAgent?: boolean
  speechEndAt?: number
  /** This utterance made the app replay the interrupted reply instead of asking the model. */
  resumed?: 'resume' | 'backchannel' | 'empty'
}

export interface ChatMessage {
  id: string
  turnId: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  via?: 'voice' | 'text'
  timing?: UserTiming
  streaming?: boolean
  interrupted?: boolean
  /** What the user actually heard before an interruption. */
  spokenText?: string
  /** What was generated but never played. */
  unspokenText?: string
  /** When the interruption happened (resume is offered for a while after it). */
  interruptedAt?: number
  /** Times this reply was replayed from its cut point. */
  resumeCount?: number
  tool?: ToolActivity
  metrics?: TurnMetrics
  /** User messages: the playbooks that fired on it and shaped the reply (docs/TRIGGERS.md). */
  playbooks?: PlaybookFiring[]
  createdAt: number
}

export interface PlaybookFiring {
  id: string
  title: string
  /** A runbook started a background run (absent on messages saved before runbooks). */
  kind?: 'playbook' | 'runbook'
  /** The condition and the numbers it read, or the phrase that matched. */
  why: string
}

/** A line and message from parsing a playbook file; line 0 = the file as a whole. */
export interface PlaybookIssue {
  line: number
  message: string
}

/** One playbook file as the Playbooks view sees it. Unparseable files have `errors` and no title. */
export interface PlaybookInfo {
  id: string
  /** The file text: the single source of truth that the editor shows and saves. */
  source: string
  ok: boolean
  errors: PlaybookIssue[]
  warnings: PlaybookIssue[]
  title?: string
  goal?: string
  enabled?: boolean
  priority?: 'low' | 'normal' | 'high' | 'critical'
  events?: string[]
  when?: string | null
  said?: string[]
  cooldownS?: number
  maxPerSession?: number | null
  tags?: string[]
  /** The yes/no question it asks Jev, if any. */
  ask?: string | null
  /** It needs Jev's answer (its intent condition or its own question) to fire. */
  usesJev?: boolean
  /** A runbook runs steps in the background; a playbook shapes the reply. */
  kind?: 'playbook' | 'runbook'
  /** Runbooks: the steps as a Mermaid flowchart, and how many there are. */
  diagram?: string
  stepCount?: number
  /** With the schedule event: when it runs by the clock. */
  schedule?: import('./schedule').Schedule | null
  /** This app run. */
  firedCount: number
  lastFiredAt: number | null
  /** Times it matched but was held back this app run, and the latest reason (a DROP_REASON key). */
  skippedCount?: number
  lastSkip?: { at: number; reason: string; by?: string } | null
}

/** One line of the trigger log: a playbook fired, or matched and was held back. Newest first, this app run. */
export interface TriggerActivity {
  at: number
  id: string
  title: string
  outcome: 'fired' | 'skipped'
  /** fired: why it matched ("turn.user and chars > 1200"); skipped: the DROP_REASON key. */
  detail: string
  /** The event it came from, when not a user message. */
  by?: string
}

export interface PlaybooksState {
  /** The folder the files live in, shown so the user can open it. */
  dir: string
  playbooks: PlaybookInfo[]
  /** The latest trigger decisions, newest first (fired, or held back and why). */
  activity?: TriggerActivity[]
  /** Whether playbooks that need Jev can fire: ready, no TypeSafe key, or switched off in Tuning. */
  jev: 'ready' | 'no_key' | 'off'
}

export interface PlaybookCheck {
  errors: PlaybookIssue[]
  warnings: PlaybookIssue[]
  /** Runbooks that load: their steps as a Mermaid flowchart, for the live view while editing. */
  diagram?: string
}

/** One recent user message replayed against a playbook draft. */
export interface PlaybookTestRow {
  text: string
  createdAt: number
  via?: 'voice' | 'text'
  /** Why it would match, or null. Gates (cooldown, caps) are not applied. */
  why: string | null
}

export type RunbookRunStatus = 'running' | 'waiting' | 'done' | 'blocked' | 'out_of_budget' | 'cancelled' | 'expired' | 'interrupted'

/** One run of a runbook (docs/TRIGGERS.md), saved after every step. */
export interface RunbookRun {
  runId: string
  runbookId: string
  title: string
  status: RunbookRunStatus
  /** The step it is on (running, waiting) or stopped at. */
  step: string | null
  /** What the steps saved, plus text (the message that started it) and recent (the messages before it). */
  scratch: Record<string, unknown>
  log: Array<{ step: string; kind: string; outcome: 'ok' | 'error' | 'refused'; ms: number; note?: string; at: number }>
  startedAt: number
  updatedAt: number
  /** Working time, waits for the user not counted. */
  activeMs: number
  /** Steps run so far. */
  steps: number
  /** Set when it is waiting for the user's reply. */
  waiting?: { since: number; expiresAt: number; save: string; question?: string }
  /** The user has replied to it (a claude step needs this). */
  consented: boolean
  /** Why it stopped, when it did not finish normally. */
  reason?: string
}

/** The user's mark on a message for one playbook: it should have fired there, or it should not have. */
export type PlaybookLabel = 'should' | 'should_not'

/** One recent message in a review: what the trigger does on it, and what it should do. */
export interface PlaybookEvalRow {
  messageId: string
  text: string
  createdAt: number
  via?: 'voice' | 'text'
  /** The current trigger fires on it (and why). */
  fires: boolean
  why: string | null
  /** It should fire: by the user's mark, else the judge; null = unsure. */
  should: boolean | null
  /** Jev's yes probability, when Jev judged. */
  p: number | null
  by: 'label' | 'jev' | 'model' | 'none'
  label?: PlaybookLabel
  verdict: 'agree' | 'miss' | 'false_fire' | 'unsure'
}

export interface PlaybookEvalResult {
  rows: PlaybookEvalRow[]
  summary: { checked: number; fires: number; agree: number; misses: number; falseFires: number; unsure: number }
  /** How the judging went: Jev or the model, the cost, or why there was none. */
  note?: string
}

export type PlaybookSaveResult = { ok: true; id: string } | { ok: false; errors: PlaybookIssue[] }

export interface Session {
  id: string
  title: string
  projectId: string
  createdAt: number
  messageCount: number
}

export type MemoryKind = 'profile' | 'fact' | 'decision' | 'todo'

export interface MemoryEntry {
  id: number
  scopeId: string
  kind: MemoryKind
  key: string
  value: string
  tags: string[]
  source: 'user' | 'agent' | 'ui'
  createdAt: number
  updatedAt: number
}

export interface MemoryScope {
  id: string
  name: string
  count: number
}

export interface Project {
  id: string
  name: string
  path?: string
  defaultStyleId?: string
  createdAt: number
}

export interface PendingMemorySave {
  id: string
  key: string
  value: string
  kind: MemoryKind
  tags: string[]
  /** `delete` asks before forgetting an existing entry (`entryId`). */
  action?: 'save' | 'delete'
  entryId?: number
}

/** One change to a memory entry; `before`/`after` are JSON snapshots ({key, value, kind, tags}) or null for create/delete. */
export interface MemoryHistoryEntry {
  id: number
  entryId: number
  before: MemorySnapshot | null
  after: MemorySnapshot | null
  source: string
  at: number
}

export interface MemorySnapshot {
  key: string
  value: string
  kind: MemoryKind
  tags: string[]
}

export interface AudioDeviceSettings {
  inputDeviceId?: string
  inputLabel?: string
  outputDeviceId?: string
  outputLabel?: string
}

// Behavioural numbers are defined once in ./tuning; these aliases keep call sites readable.
export type EndpointSettings = TuningValues['endpoint']
export type BrainSettings = TuningValues['brain']
export type SpeechSettings = TuningValues['speech']
export type PlaybackSettings = TuningValues['playback']
export type MemorySettings = TuningValues['memory']
export type PlaybookSettings = TuningValues['playbooks']
export type RuntimeSettings = TuningValues['runtime']

export interface SttSettings {
  model: string
  device: 'hybrid' | 'cuda' | 'cpu'
  pythonPath: string
}

/** Hosted voice APIs; each needs a key (Settings > Providers or .env). Metadata lives in ./tts. */
export type CloudTtsProvider = 'elevenlabs' | 'fish' | 'inworld' | 'qwen'
/** Keys for services that are not a chat model or a voice: TypeSafe runs Jev, the playbooks' decision model. */
export type ServiceKeyProvider = 'typesafe'
/** Everything the key store holds a key for. */
export type KeyName = Provider | CloudTtsProvider | ServiceKeyProvider
export type TtsEngineId = 'edge' | 'kokoro' | 'pocket' | 'system' | CloudTtsProvider

export interface CloudVoiceChoice {
  /** Voice id as the provider names it; empty = the provider's default (or the .env default). */
  voice?: string
  model?: string
  /** Qwen only: a free-text delivery instruction sent with every sentence. */
  instruction?: string
}

export interface TtsProxySettings {
  /** http://user:pass@host:port; empty = direct. Seeded from TTS_PROXY. */
  url: string
  /** Route Edge TTS through it (Microsoft throttles the free voice per IP). */
  edge: boolean
  /** Route the hosted voice APIs through it too. */
  cloud: boolean
  /** Proxies to choose from, one per line (host:port:user:pass or a URL); PROXY_LIST_URL in .env adds a fetched list. */
  list: string
  /**
   * Pick Edge's route by itself: direct while it is quick, the fastest listed proxy when Edge is throttled
   * (see main/services/edgeRoute). Off: `url` with the `edge` toggle, as set by hand.
   */
  auto?: boolean
}

/** One route tested by "Find fastest": Edge time to first audio through it. `url` '' is the direct connection. */
export interface ProxyRank {
  url: string
  /** host:port, or "direct"; never the credentials. */
  label: string
  /** Median ms to first audio, socket open included, over the runs that worked; null when none did. */
  firstMs: number | null
  ok: number
  runs: number
  error?: string
  /** Country code and city of the proxy IP ('' = unknown or direct). */
  country?: string
}

/** The chosen Edge voice has been slow to start; `twin` is the plain voice of the same name, measured quicker. */
export interface SlowVoiceNotice {
  voice: string
  /** Median ms until a sentence's audio was ready, over the last few spoken. */
  ms: number
  twin?: string
  twinMs?: number
}

/** The automatic Edge route (Settings > Voice output): which way Edge goes out now and why. */
export interface EdgeRouteState {
  /** Proxy URL in use; '' = direct. */
  url: string
  label: string
  country: string
  /** Last measured ms to first audio through the route in use, and direct. */
  firstMs: number | null
  directMs: number | null
  /** Last check of any kind, and last full test of every route (epoch ms, 0 = never). */
  checkedAt: number
  rankedAt: number
  testing: boolean
  /** Proxies in the ranking. */
  proxies: number
  /** One line on the last decision. */
  note: string
  /** The ranking, fastest first (direct included, url ''). */
  rows: ProxyRank[]
}

export interface VoiceSettings {
  engine: TtsEngineId
  voice: string
  /** Kokoro voice id (e.g. af_heart); used when Edge is unreachable or Kokoro is the engine. */
  kokoroVoice: string
  /** Pocket TTS built-in voice (e.g. cosette), or a voice file URL. */
  pocketVoice?: string
  /** Pocket TTS server: the pocket-tts command or its path (empty: POCKET_TTS_COMMAND, else pocket-tts on the PATH), or the http address of a server you run. */
  pocketServer?: string
  rate: number
  pitch: number
  /** Per hosted provider: the voice and model to use, kept so switching engines remembers choices. */
  cloud: Partial<Record<CloudTtsProvider, CloudVoiceChoice>>
  /** Tell the model it may write delivery cues ([laughs], (sighing) …) when the engine understands them. */
  expressive: boolean
  proxy: TtsProxySettings
}

export type ThemePref = 'dark' | 'light' | 'system'

export interface BehaviourSettings {
  /** Dark (default), light, or follow the OS. */
  theme: ThemePref
  confirmBeforeSave: boolean
  fillerBeforeTools: boolean
  loadingSound: boolean
  speakTypedReplies: boolean
  listenOnLaunch: boolean
  /** Load the speech recognition (Parakeet) at launch and never unload it while idle; costs GPU memory, saves the ~20 s cold load. */
  keepEarsLoaded?: boolean
}

export interface LocationSettings {
  mode: 'manual' | 'ip' | 'off'
  manual: string
}

export interface ClaudeSettings {
  /** Voice control of Claude Code sessions (adds the claude_* tools and the Claude view). */
  enabled: boolean
  /** Every session workspace is created directly under this folder; sessions cannot leave their own. */
  workspaceRoot: string
  /** Model for sessions; empty = the Claude Code default. */
  model: string
  /** Sessions open at once (idle, working or waiting); stopped ones don't count. 1-24. */
  maxSessions: number
  /** Written once the limit has a setting: a stored 4 without it is the old fixed limit, not a choice. */
  limitChosen?: boolean
  /** How much a new session may do on its own (each session can be switched later). */
  defaultMode: CcMode
}

/** Read-only look around the PC (the pc_* tools): which folders the agent may read, and whether it may chain look-ups by itself. */
export interface ExploreSettings {
  enabled: boolean
  /** Approved folders, as absolute paths ("D:\\", "C:\Users\me\Projects"). Nothing outside them can be listed, searched or read. */
  roots: string[]
  /** Offer pc_explore: the explorer works on a whole goal by itself and returns one short answer. */
  agent: boolean
  /** The explorer may change text inside existing files in the approved folders (a copy is kept first). Never deletes, moves or creates. */
  edit: boolean
  /** The explorer may run the allowlisted read-only commands (ls, dir, cat, type, grep, find, git status, git log…). */
  terminal: boolean
  /** Set once the first-run folders (the app's own, the session workspace, project folders) have been added. */
  seeded?: boolean
}

export interface Settings {
  modelId: string
  fallbackModelId: string
  mode: Mode
  styleId: string
  projectId: string
  agentName: string
  userName: string
  /** One line about the user for the prompt ("technical, prefers direct answers"). */
  aboutUser: string
  voice: VoiceSettings
  audio: AudioDeviceSettings
  endpoint: EndpointSettings
  brain: BrainSettings
  speech: SpeechSettings
  playback: PlaybackSettings
  memory: MemorySettings
  playbooks: PlaybookSettings
  runtime: RuntimeSettings
  stt: SttSettings
  behaviour: BehaviourSettings
  location: LocationSettings
  searxng: { url: string; autostart: boolean }
  mcp: { enabled: boolean }
  claude: ClaudeSettings
  explore: ExploreSettings
}

export interface KeyStatus {
  provider: KeyName
  set: boolean
  hint?: string
}

export interface McpToolInfo {
  server: string
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  enabled: boolean
  command: string
  transport: 'stdio' | 'http'
  state: ServiceState
  error?: string
  tools: McpToolInfo[]
  stderrTail: string[]
  connectedAt?: number
  calls: number
}

export interface StyleDraft {
  label: string
  desc: string
  body: string
}

export interface VoiceInfo {
  name: string
  shortName: string
  locale: string
  gender: string
}

export interface TtsModelInfo {
  id: string
  label: string
  note?: string
  /** Understands inline delivery cues (see ./tts for the syntax per provider). */
  tags?: boolean
}

/** What a hosted voice provider offers: live where the API lists it, otherwise the built-in list. */
export interface TtsCatalog {
  provider: CloudTtsProvider
  voices: VoiceInfo[]
  models: TtsModelInfo[]
  /** Set when the listing call failed (no key, offline); the built-in entries are returned instead. */
  error?: string
}

export interface ContextSnapshot {
  now: string
  timezone: string
  location: string
  project: string
  style: string
  memoryEntries: number
  skills: string[]
  tools: string[]
}

export interface Toast {
  id: string
  kind: 'info' | 'warn' | 'error'
  text: string
}

// ---- events main -> renderer --------------------------------------------------------------
export type AgentEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'service'; status: ServiceStatus }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message-removed'; id: string }
  | { type: 'partial'; text: string }
  | { type: 'level'; p: number }
  | { type: 'metrics'; turnId: string; metrics: TurnMetrics }
  | { type: 'duck'; gain: number }
  | { type: 'cue'; on: boolean }
  | { type: 'memory-confirm'; pending: PendingMemorySave | null }
  | { type: 'memory-changed' }
  | { type: 'sessions-changed' }
  | { type: 'settings-changed'; settings: Settings }
  | { type: 'toast'; toast: Toast }
  | { type: 'edge-route'; state: EdgeRouteState }
  | { type: 'voice-slow'; notice: SlowVoiceNotice }
  | { type: 'context'; snapshot: ContextSnapshot }
  | { type: 'skills-changed' }
  | { type: 'playbooks-changed' }
  | { type: 'runbooks-changed' }
  | { type: 'mcp-changed' }
  | { type: 'claude'; event: CcManagerEvent }
  /** A diagram was drawn, changed or (doc null) deleted. */
  | { type: 'diagram'; id: string; doc: DiagramDoc | null }

export interface AudioChunk {
  turnId: string
  seq: number
  text: string
  mp3: ArrayBuffer
  last: boolean
  /** Fillers are spoken but never count as part of the reply the user heard. */
  kind: 'speech' | 'filler'
  /** Main-process clock when the chunk left the agent; the renderer echoes it back so the UI stage can be timed. */
  emittedAt?: number
}
