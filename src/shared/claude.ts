/** Claude Code session types shared by core (manager/tools), main (service/IPC) and the renderer. */

/**
 * How much a session may do on its own:
 *  - plan: it looks around and writes a plan; nothing changes until the user approves the plan
 *  - ask: every shell command asks first
 *  - auto: no questions for work inside its folder; stepping outside it, deleting or pushing asks
 *  - bypass: no questions at all (a delete reaching outside its folder still asks; machine-level commands never run)
 */
export type CcMode = 'plan' | 'ask' | 'auto' | 'bypass'
export const CC_MODES: CcMode[] = ['plan', 'ask', 'auto', 'bypass']

export type CcStatus = 'idle' | 'running' | 'needs_input' | 'needs_permission' | 'error' | 'stopped'

export interface CcQuestion {
  question: string
  header: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}

/** Something the session is blocked on, waiting for the user's voice (or typed) answer. */
export type CcPending =
  | { id: string; kind: 'question'; toolName: 'AskUserQuestion'; questions: CcQuestion[]; summary: string }
  | { id: string; kind: 'permission'; toolName: string; summary: string; /** why the fence asked (outside its folder, deletes files…) */ reason?: string }
  /** Plan mode finished planning: the user approves (and picks the mode to build in) or sends it back with feedback. */
  | { id: string; kind: 'plan'; toolName: 'ExitPlanMode'; plan: string; summary: string }

export interface CcEvent {
  t: number
  kind: 'user' | 'text' | 'tool' | 'tool_result' | 'denied' | 'result' | 'error' | 'status' | 'interrupt'
  text: string
  /** tool / tool_result: the SDK tool_use id that pairs a call with its output. */
  toolId?: string
  /** tool: the tool name and its input (long strings clipped), for rich rendering. */
  tool?: string
  input?: Record<string, unknown>
  /** tool_result: the tool reported a failure. */
  isError?: boolean
  /** result: how the turn went. */
  durationMs?: number
  costUsd?: number
  turns?: number
}

/** A saved Claude Code session elsewhere on this machine (CLI, IDE, other apps). */
export interface CcExternal {
  sessionId: string
  title: string
  cwd: string
  branch?: string
  lastModified: number
  createdAt?: number
  size?: number
}

/** One entry of a session's workspace listing; `path` is relative with forward slashes. */
export interface CcFile {
  path: string
  dir: boolean
  size: number
  mtime: number
  /** A folder that is not listed (node_modules, .git, …) or the listing hit its cap. */
  skipped?: boolean
}

export type CcFileContent =
  | { kind: 'text'; text: string; size: number; truncated: boolean }
  | { kind: 'binary'; size: number }

/** Serializable snapshot, safe to send over IPC. */
/** 'subscription' = the user's Claude login (plan usage); 'api-key' = billed per token to an API key. */
export type CcBilling = 'subscription' | 'api-key' | 'other'

/** Who Claude Code sessions run as, asked of the CLI itself. */
export interface CcAccount {
  billing: CcBilling | 'unknown'
  email?: string
  organization?: string
  /** e.g. "Claude Max" */
  plan?: string
  /** Where an API key came from, when one is in use (e.g. "ANTHROPIC_API_KEY", "apiKeyHelper"). */
  keySource?: string
  /** e.g. "bedrock", when not Anthropic directly */
  provider?: string
  error?: string
}

export interface CcSession {
  id: string
  name: string
  workspace: string
  status: CcStatus
  /** Its permission mode (older saved sessions have none: the default mode applies). */
  mode?: CcMode
  /** SDK session id, used to resume after a restart or disconnect. */
  sdkSessionId?: string
  /** Attached from a saved Claude Code session: works in that real project folder, not a sandbox. */
  external?: boolean
  /** The next run forks the conversation (attached sessions leave the original transcript untouched). */
  forkOnResume?: boolean
  /** What the last run billed, from the CLI's own report: the user's Claude login, or an API key. */
  billing?: CcBilling
  pending?: CcPending
  queued: string[]
  lastSummary: string
  costUsd: number
  turns: number
  createdAt: number
  updatedAt: number
}

export type CcManagerEvent =
  | { type: 'session'; session: CcSession }
  | { type: 'event'; id: string; event: CcEvent }
  | { type: 'needs-input'; id: string; name: string; pending: CcPending }
  | { type: 'finished'; id: string; name: string; summary: string }
  | { type: 'removed'; id: string }

export type CcAnswer =
  | { kind: 'choice'; choices: number[]; text?: undefined } // 1-based option numbers
  | { kind: 'text'; text: string }
  /** `mode`: switch the session to this mode too (a plan: the mode to build in; an approval: e.g. auto = stop asking) */
  | { kind: 'allow'; mode?: CcMode }
  /** For a plan, `reason` is the feedback it revises the plan with. */
  | { kind: 'deny'; reason?: string }

export type CcResult<T = object> = ({ ok: true } & T) | { ok: false; error: string }
