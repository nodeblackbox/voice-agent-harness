import { Plus } from 'lucide-react'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { statusColor, statusLabel } from '../../state/claude'
import { Dot } from '../primitives'
import { ClaudeMark, CLAUDE_ORANGE } from '../../views/claude/ClaudeMark'

/**
 * Claude Code at a glance, above the chat input while Claude control is on: one chip per session
 * (amber and pulsing when it needs you). Tapping a chip opens that session in the Claude Code view.
 */
export function ClaudeStrip() {
  const sessions = useStore((s) => s.claudeSessions)
  const selectClaude = useStore((s) => s.selectClaude)
  const setView = useStore((s) => s.setView)
  const open = (id?: string) => {
    if (id) selectClaude(id)
    setView('claude')
  }
  const chip = { height: 26, padding: '0 10px', border: `1px solid ${T.border}`, background: T.surface, cursor: 'pointer' } as const

  return (
    <div className="flex items-center gap-1.5 px-1 flex-wrap va-fade" aria-label="Claude Code sessions">
      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: CLAUDE_ORANGE }}>
        <ClaudeMark size={13} working={sessions.some((s) => s.status === 'running')} /> Claude Code
      </span>
      {sessions.length === 0 && (
        <span className="text-xs" style={{ color: T.text3 }}>
          say “start a session called landing page and build…”
        </span>
      )}
      {sessions.map((s) => (
        <button
          key={s.id}
          onClick={() => open(s.id)}
          title={s.pending ? s.pending.summary : s.lastSummary || statusLabel(s.status)}
          className="inline-flex items-center gap-1.5 rounded-full text-xs"
          style={{ ...chip, color: s.pending ? T.amber : T.text2, background: s.pending ? T.amberTint : T.surface, borderColor: s.pending ? T.amber : T.border }}
        >
          <Dot color={statusColor(s.status, T)} pulse={s.status === 'running' || !!s.pending} size={6} />
          <span style={{ maxWidth: 140 }} className="truncate">{s.name}</span>
          <span style={{ color: T.text3 }}>{statusLabel(s.status)}</span>
        </button>
      ))}
      <button onClick={() => open()} aria-label="Open Claude Code" className="inline-flex items-center gap-1 rounded-full text-xs" style={{ ...chip, color: T.text3 }}>
        <Plus size={11} /> {sessions.length ? 'Open' : 'New'}
      </button>
    </div>
  )
}
