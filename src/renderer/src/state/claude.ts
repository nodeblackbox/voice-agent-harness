/** Pure state logic for the Claude Code view: apply a manager event to the local session list and output log. */
import type { CcEvent, CcManagerEvent, CcSession, CcStatus } from '@shared/claude'

export interface ClaudeState {
  sessions: CcSession[]
  /** Recent events per session, newest last. */
  output: Record<string, CcEvent[]>
}

export const OUTPUT_CAP = 300

export function applyClaudeEvent(s: ClaudeState, e: CcManagerEvent): ClaudeState {
  if (e.type === 'session') {
    const i = s.sessions.findIndex((x) => x.id === e.session.id)
    const sessions = i >= 0 ? s.sessions.map((x, j) => (j === i ? e.session : x)) : [...s.sessions, e.session]
    return { ...s, sessions }
  }
  if (e.type === 'removed') {
    const { [e.id]: _gone, ...output } = s.output
    return { sessions: s.sessions.filter((x) => x.id !== e.id), output }
  }
  if (e.type === 'event') {
    const prev = s.output[e.id] ?? []
    const next = prev.length >= OUTPUT_CAP ? [...prev.slice(prev.length - OUTPUT_CAP + 1), e.event] : [...prev, e.event]
    return { ...s, output: { ...s.output, [e.id]: next } }
  }
  return s
}

export function statusColor(status: CcStatus, T: { amber: string; violet: string; green: string; red: string; text3: string; cyan: string }): string {
  switch (status) {
    case 'needs_input':
    case 'needs_permission':
      return T.amber
    case 'running':
      return T.violet
    case 'idle':
      return T.green
    case 'error':
      return T.red
    default:
      return T.text3
  }
}

export const statusLabel = (status: CcStatus): string =>
  ({ idle: 'idle', running: 'working', needs_input: 'needs you', needs_permission: 'needs approval', error: 'error', stopped: 'stopped' })[status]

/** Sessions blocked on the user, oldest first: the "needs you" count in the nav and header. */
export const waitingOnUser = (sessions: CcSession[]): CcSession[] => sessions.filter((s) => s.pending).sort((a, b) => a.updatedAt - b.updatedAt)
