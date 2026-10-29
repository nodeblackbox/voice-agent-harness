/** Session permission modes: the badge, the header switcher and the four-way chooser (new session, settings). */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ClipboardList, FastForward, Hand, ShieldOff, type LucideIcon } from 'lucide-react'
import { CC_MODES, type CcMode, type CcSession } from '@shared/claude'
import { T, alpha } from '../../theme'
import { useStore } from '../../state/store'

export const MODES: Record<CcMode, { label: string; icon: LucideIcon; color: string; blurb: string }> = {
  plan: { label: 'Plan', icon: ClipboardList, color: T.cyan, blurb: 'Plans first. Nothing changes until you approve the plan.' },
  ask: { label: 'Ask', icon: Hand, color: T.steel, blurb: 'Every shell command waits for your yes.' },
  auto: { label: 'Auto', icon: FastForward, color: T.green, blurb: 'No questions inside its folder. Going outside it, deleting or pushing asks.' },
  bypass: { label: 'Bypass', icon: ShieldOff, color: T.bypass, blurb: 'No questions at all. Deletes outside its folder ask; wiping disks never runs.' }
}

export const modeOf = (s: CcSession, fallback: CcMode): CcMode => s.mode ?? fallback

/** Small inline badge (session list). */
export function ModeBadge({ mode }: { mode: CcMode }) {
  const m = MODES[mode]
  return (
    <span title={`${m.label} mode: ${m.blurb}`} className="inline-flex items-center gap-1 rounded-full px-1.5" style={{ fontSize: 10.5, lineHeight: '16px', color: m.color, background: `${alpha(m.color, 8)}`, border: `1px solid ${alpha(m.color, 20)}`, flexShrink: 0 }}>
      <m.icon size={10} />
      {m.label}
    </span>
  )
}

/** The header switcher: current mode as a pill, the four modes in a menu. Changes apply live. */
export function ModeMenu({ session, fallback }: { session: CcSession; fallback: CcMode }) {
  const pushToast = useStore((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const mode = modeOf(session, fallback)
  const m = MODES[mode]
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [open])
  const pick = async (next: CcMode) => {
    setOpen(false)
    if (next === mode || typeof window.api.claude.setMode !== 'function') return
    const r = await window.api.claude.setMode(session.id, next)
    if (!r.ok) pushToast('error', r.error)
  }
  return (
    <div ref={ref} className="relative" style={{ flexShrink: 0 }}>
      <button
        type="button"
        aria-label={`Mode: ${m.label}. Change mode`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={m.blurb}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium"
        style={{ height: 26, color: m.color, background: `${alpha(m.color, 7)}`, border: `1px solid ${alpha(m.color, 27)}`, cursor: 'pointer' }}
      >
        <m.icon size={13} />
        {m.label}
        <ChevronDown size={12} style={{ opacity: 0.7, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} />
      </button>
      {open && (
        <div role="menu" className="absolute rounded-xl shadow-2xl overflow-hidden va-fade py-1" style={{ top: 'calc(100% + 6px)', right: 0, width: 300, background: T.raised, border: `1px solid ${T.border}`, zIndex: 40 }}>
          <div className="px-3 pt-1.5 pb-1 text-xs" style={{ color: T.text3 }}>How much it does on its own · applies now</div>
          {CC_MODES.map((k) => {
            const x = MODES[k]
            const on = k === mode
            return (
              <button key={k} role="menuitemradio" aria-checked={on} type="button" onClick={() => void pick(k)} className="va-tree-row w-full flex items-start gap-2.5 px-3 py-2 text-left" style={{ cursor: 'pointer', background: on ? `${alpha(x.color, 5)}` : 'transparent' }}>
                <span className="inline-flex items-center justify-center rounded-md" style={{ width: 24, height: 24, background: `${alpha(x.color, 9)}`, color: x.color, flexShrink: 0 }}>
                  <x.icon size={13} />
                </span>
                <span className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm" style={{ color: on ? x.color : T.text }}>{x.label}</span>
                  <span className="text-xs" style={{ color: T.text3, lineHeight: 1.4 }}>{x.blurb}</span>
                </span>
                {on && <Check size={14} style={{ color: x.color, marginTop: 5, flexShrink: 0 }} />}
              </button>
            )
          })}
          {session.pending && session.pending.kind !== 'question' && (
            <div className="px-3 pt-1 pb-1.5 text-xs" style={{ color: T.text3, borderTop: `1px solid ${T.border}`, lineHeight: 1.45 }}>
              {session.pending.kind === 'plan' ? 'Picking a building mode approves the waiting plan.' : 'Auto or Bypass also approves what it is waiting on.'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Four-way chooser for a new session and the default in Settings. */
export function ModeChooser({ value, onChange, label = 'Mode' }: { value: CcMode; onChange: (m: CcMode) => void; label?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div role="radiogroup" aria-label={label} className="grid grid-cols-4 gap-1 rounded-lg p-1" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
        {CC_MODES.map((k) => {
          const x = MODES[k]
          const on = k === value
          return (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(k)}
              title={x.blurb}
              className="inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs"
              style={{ cursor: 'pointer', color: on ? x.color : T.text3, background: on ? `${alpha(x.color, 9)}` : 'transparent', border: `1px solid ${on ? `${alpha(x.color, 31)}` : 'transparent'}` }}
            >
              <x.icon size={12} />
              {x.label}
            </button>
          )
        })}
      </div>
      <div className="text-xs" style={{ color: T.text3, lineHeight: 1.45 }}>{MODES[value].blurb}</div>
    </div>
  )
}
