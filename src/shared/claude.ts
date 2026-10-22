/** Claude Code session types shared by core (manager/tools), main (service/IPC) and the renderer. */

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
  | { id: string; kind: 'permission'; toolName: string; summary: string }

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
export interface CcSession {
  id: string
  name: string
  workspace: string
  status: CcStatus
  /** SDK session id, used to resume after a restart or disconnect. */
  sdkSessionId?: string
  /** Attached from a saved Claude Code session: works in that real project folder, not a sandbox. */
  external?: boolean
  /** The next run forks the conversation (attached sessions leave the original transcript untouched). */
  forkOnResume?: boolean
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
  | { kind: 'allow' }
  | { kind: 'deny'; reason?: string }

export type CcResult<T = object> = ({ ok: true } & T) | { ok: false; error: string }
