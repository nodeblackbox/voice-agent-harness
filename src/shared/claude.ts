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
}

/** Serializable snapshot, safe to send over IPC. */
export interface CcSession {
  id: string
  name: string
  workspace: string
  status: CcStatus
  /** SDK session id, used to resume after a restart or disconnect. */
  sdkSessionId?: string
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

export type CcAnswer =
  | { kind: 'choice'; choices: number[]; text?: undefined } // 1-based option numbers
  | { kind: 'text'; text: string }
  | { kind: 'allow' }
  | { kind: 'deny'; reason?: string }

export type CcResult<T = object> = ({ ok: true } & T) | { ok: false; error: string }
