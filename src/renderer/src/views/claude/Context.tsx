/** How full a session's context window is, and a way to compact it (summarise the conversation to free room). */
import { useEffect, useRef, useState } from 'react'
import { Shrink } from 'lucide-react'
import type { CcSession } from '@shared/claude'
import { fmtTokens } from '@shared/pricing'
import { T, alpha } from '../../theme'
import { useStore } from '../../state/store'

/** Green while there is room, amber past 60%, red past 80% (Claude Code compacts by itself near the top). */
export function contextColor(percent: number): string {
  return percent >= 80 ? T.red : percent >= 60 ? T.amber : T.green
}

export function contextTitle(s: CcSession): string {
  const c = s.context
  if (!c) return 'How full its context is shows after its first turn'
  const n = s.compactions ?? 0
  return `Context: ${fmtTokens(c.tokens)} of ${fmtTokens(c.max)} tokens (${c.percent}%)${n ? ` · compacted ${n}×` : ''}. Claude Code compacts by itself when it is nearly full; Compact does it now.`
}

/** A thin bar, for a session card. Nothing before the first turn. */
export function ContextBar({ session }: { session: CcSession }) {
  const c = session.context
  if (!c) return null
  const color = contextColor(c.percent)
  return (
    <div className="flex items-center gap-1.5" title={contextTitle(session)} data-testid="context-bar">
      <div className="flex-1 rounded-full overflow-hidden" style={{ height: 3, background: T.raised }}>
        <div style={{ width: `${Math.max(2, c.percent)}%`, height: '100%', background: color, transition: 'width .4s ease' }} />
      </div>
      <span style={{ color: c.percent >= 60 ? color : T.text3, fontFamily: T.mono, fontSize: 10 }}>{c.percent}%</span>
    </div>
  )
}

/** The header's meter with a Compact button that asks what to keep. */
export function ContextMeter({ session }: { session: CcSession }) {
  const pushToast = useStore((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [focus, setFocus] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [open])
  const c = session.context
  const color = c ? contextColor(c.percent) : T.text3
  const canCompact = !!session.sdkSessionId || session.turns > 0
  const go = async () => {
    const r = await window.api.claude.compact(session.id, focus)
    if (!r.ok) pushToast('error', r.error)
    else pushToast('info', r.queued ? 'It compacts once its current job is done' : 'Compacting…')
    setOpen(false)
    setFocus('')
  }
  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        aria-label="Context"
        onClick={() => setOpen(!open)}
        disabled={!canCompact}
        title={contextTitle(session)}
        className="inline-flex items-center gap-2 rounded-lg px-2"
        style={{ height: 26, background: open ? T.raised : T.surface, border: `1px solid ${c && c.percent >= 80 ? alpha(T.red, 45) : T.border}`, color: T.text2, cursor: canCompact ? 'pointer' : 'default', opacity: canCompact ? 1 : 0.6 }}
      >
        <Shrink size={12} style={{ color }} />
        <span className="text-xs hidden xl:inline">Context</span>
        <span className="rounded-full overflow-hidden" style={{ width: 44, height: 4, background: T.raised }}>
          <span className="block" style={{ width: `${c ? Math.max(3, c.percent) : 0}%`, height: '100%', background: color, transition: 'width .4s ease' }} />
        </span>
        <span className="text-xs" style={{ fontFamily: T.mono, color: c && c.percent >= 60 ? color : T.text2 }}>{c ? `${c.percent}%` : '—'}</span>
      </button>
      {open && (
        <div className="absolute rounded-xl shadow-2xl va-fade p-3 flex flex-col gap-2.5" style={{ top: 'calc(100% + 6px)', right: 0, width: 300, background: T.raised, border: `1px solid ${T.border}`, zIndex: 40 }}>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-medium" style={{ color: T.text }}>Context</span>
            <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono }}>{c ? `${fmtTokens(c.tokens)} / ${fmtTokens(c.max)}` : 'not known yet'}</span>
          </div>
          <div className="rounded-full overflow-hidden" style={{ height: 6, background: T.bg }}>
            <div style={{ width: `${c?.percent ?? 0}%`, height: '100%', background: color }} />
          </div>
          <div className="text-xs" style={{ color: T.text3, lineHeight: 1.5 }}>
            Compacting summarises the conversation so far and carries on from the summary, freeing room. Claude Code also does it by itself when the window is nearly full.
            {session.compactions ? ` Compacted ${session.compactions}× so far.` : ''}
          </div>
          <input
            autoFocus
            aria-label="What to keep"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void go() }}
            placeholder="What to keep (optional)"
            className="rounded-lg px-2.5 py-1.5 text-sm"
            style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, outline: 'none' }}
          />
          <button type="button" onClick={() => void go()} className="rounded-lg py-1.5 text-sm font-medium" style={{ background: T.text, color: T.bg, cursor: 'pointer' }}>
            Compact now
          </button>
        </div>
      )}
    </div>
  )
}
