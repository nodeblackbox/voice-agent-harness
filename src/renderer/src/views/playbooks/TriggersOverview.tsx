// The Triggers overview: every event the app can react to, what listens to each one, and what each trigger did
// this run (fired, or matched and was held back, and why). Picking a row opens that file.
import { useMemo, useState } from 'react'
import { ListChecks, Plus, Workflow, Zap } from 'lucide-react'
import type { PlaybookInfo, PlaybooksState, TriggerActivity } from '@shared/types'
import { DROP_REASON } from '@shared/console'
import { nextRuns, clockTime } from '@shared/schedule'
import { T, alpha } from '../../theme'
import { Toggle } from '../../components/primitives'
import { ago, triggerLine } from './parts'
import { EVENTS, GROUPS, eventWords, type EventInfo } from './events'

/** The events a file listens to; a prefix such as "cc." counts for each event it covers. */
function listensTo(p: PlaybookInfo, id: string): boolean {
  const ev = p.events?.length ? p.events : ['turn.user']
  return ev.some((e) => e === id || (e.endsWith('.') && id.startsWith(e)))
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl px-4 py-3" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
      <span className="text-xs" style={{ color: T.text3 }}>{label}</span>
      <span className="text-xl font-semibold" style={{ color: color ?? T.text, fontFamily: T.mono }}>{value}</span>
      {sub && <span className="text-[11px] truncate" style={{ color: T.text3 }}>{sub}</span>}
    </div>
  )
}

function Row({ p, onOpen, onToggle }: { p: PlaybookInfo; onOpen: () => void; onToggle: (on: boolean) => void }) {
  const on = !!p.enabled
  const tint = p.kind === 'runbook' ? T.cyan : T.violet
  const Icon = p.kind === 'runbook' ? ListChecks : Workflow
  const skip = p.lastSkip
  return (
    <div
      role="button"
      tabIndex={0}
      data-trigger={p.id}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen() }}
      className="flex items-center gap-3 rounded-lg px-3 py-2"
      style={{ cursor: 'pointer', background: T.bg, border: `1px solid ${T.border}`, opacity: on ? 1 : 0.65 }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = alpha(tint, 45) }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = T.border }}
    >
      <Icon size={14} style={{ color: on ? tint : T.text3, flexShrink: 0 }} />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm truncate" style={{ color: T.text }}>{p.title ?? p.id}</span>
        <span className="text-xs truncate" style={{ color: T.text3, fontFamily: p.when && !p.said?.length && !p.events?.includes('schedule') ? T.mono : undefined }}>{triggerLine(p, true)}</span>
      </div>
      <div className="flex flex-col items-end shrink-0 text-[11px]" style={{ minWidth: 120 }}>
        {p.firedCount > 0 ? (
          <span style={{ color: T.green }}>fired {p.firedCount}× · {ago(p.lastFiredAt)}</span>
        ) : (
          <span style={{ color: T.text3 }}>{on ? 'not fired yet' : 'off'}</span>
        )}
        {skip && (
          <span title={`Last held back ${ago(skip.at)}`} style={{ color: T.amber }}>
            held back {p.skippedCount}×: {DROP_REASON[skip.reason] ?? skip.reason}
          </span>
        )}
      </div>
      <span onClick={(e) => e.stopPropagation()} className="shrink-0">
        <Toggle on={on} onChange={onToggle} />
      </span>
    </div>
  )
}

function Event({ e, files, onOpen, onToggle, onCreate }: { e: EventInfo; files: PlaybookInfo[]; onOpen: (p: PlaybookInfo) => void; onToggle: (p: PlaybookInfo, on: boolean) => void; onCreate: (event: string) => void }) {
  const Icon = e.icon
  const live = files.filter((p) => p.enabled).length
  return (
    <div className="flex flex-col gap-1.5" data-event={e.id}>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center justify-center rounded-md" style={{ width: 22, height: 22, background: files.length ? T.cyanTint : T.raised, flexShrink: 0 }}>
          <Icon size={12} style={{ color: files.length ? T.cyan : T.text3 }} />
        </span>
        <span className="text-sm font-medium" style={{ color: files.length ? T.text : T.text2 }}>{e.label}</span>
        <span className="text-xs truncate" style={{ color: T.text3 }}>{e.help}</span>
        <span className="ml-auto text-[11px] shrink-0" style={{ color: T.text3 }}>
          {files.length ? `${live} on${files.length > live ? ` · ${files.length - live} off` : ''}` : ''}
        </span>
        <button
          type="button"
          aria-label={`New runbook on ${e.label}`}
          title={e.id === 'turn.user' ? 'New playbook on what you say' : 'New runbook on this event'}
          onClick={() => onCreate(e.id)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 text-[11px] shrink-0"
          style={{ height: 22, background: 'transparent', color: T.text3, border: `1px dashed ${T.border}`, cursor: 'pointer' }}
        >
          <Plus size={11} /> New
        </button>
      </div>
      <div className="flex flex-col gap-1.5 pl-[30px]">
        {files.map((p) => <Row key={p.id} p={p} onOpen={() => onOpen(p)} onToggle={(v) => onToggle(p, v)} />)}
        {!files.length && <span className="text-xs" style={{ color: T.text3 }}>Nothing reacts to this yet.</span>}
      </div>
    </div>
  )
}

function Log({ items, onOpen }: { items: TriggerActivity[]; onOpen: (id: string) => void }) {
  if (!items.length) return <div className="text-xs px-1" style={{ color: T.text3 }}>Nothing has fired or been held back since the app started.</div>
  return (
    <div className="flex flex-col rounded-xl overflow-hidden" style={{ border: `1px solid ${T.border}` }} data-testid="trigger-log">
      {items.map((a, i) => (
        <button
          key={`${a.at}-${a.id}-${i}`}
          type="button"
          onClick={() => onOpen(a.id)}
          className="flex items-center gap-3 px-3 py-2 text-left"
          style={{ cursor: 'pointer', background: i % 2 ? T.surface : T.bg, borderTop: i ? `1px solid ${T.border}` : 'none' }}
        >
          <span className="text-[11px] shrink-0" style={{ color: T.text3, fontFamily: T.mono, width: 44 }}>{clockTime(new Date(a.at).getHours() * 60 + new Date(a.at).getMinutes())}</span>
          <span className="rounded px-1.5 py-px text-[10.5px] shrink-0" style={{ background: a.outcome === 'fired' ? T.greenTint : T.amberTint, color: a.outcome === 'fired' ? T.green : T.amber }}>
            {a.outcome === 'fired' ? 'fired' : 'held back'}
          </span>
          <span className="text-sm truncate shrink-0" style={{ color: T.text, maxWidth: 220 }}>{a.title}</span>
          <span className="text-xs truncate flex-1" style={{ color: T.text3 }}>
            {a.outcome === 'fired' ? a.detail : DROP_REASON[a.detail] ?? a.detail}
          </span>
          {a.by && a.by !== 'turn.user' && <span className="text-[11px] shrink-0" style={{ color: T.text3 }}>on {eventWords(a.by)}</span>}
        </button>
      ))}
    </div>
  )
}

export function TriggersOverview({ data, list, onOpen, onToggle, onCreate }: { data: PlaybooksState; list: PlaybookInfo[]; onOpen: (id: string) => void; onToggle: (p: PlaybookInfo, on: boolean) => void; onCreate: (event: string) => void }) {
  const [showEmpty, setShowEmpty] = useState(true)
  const ok = list.filter((p) => p.ok)
  const activity = data.activity ?? []
  const fired = ok.reduce((n, p) => n + p.firedCount, 0)
  const held = ok.reduce((n, p) => n + (p.skippedCount ?? 0), 0)
  const next = useMemo(() => {
    const now = new Date()
    let best: { at: Date; title: string } | null = null
    for (const p of ok) {
      if (!p.enabled || !p.schedule || !p.events?.includes('schedule')) continue
      const at = nextRuns(p.schedule, now, 1)[0]
      if (at && (!best || at < best.at)) best = { at, title: p.title ?? p.id }
    }
    return best
  }, [ok])
  // events the files name that this version does not know (a typo, or one from a later version)
  const unknown = ok.filter((p) => (p.events ?? []).some((e) => !EVENTS.some((x) => x.id === e) && !EVENTS.some((x) => e.endsWith('.') && x.id.startsWith(e))))

  return (
    <section className="flex-1 flex flex-col min-w-0 min-h-0" aria-label="Triggers overview">
      <header className="flex items-start gap-3 px-6 py-4" style={{ borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span className="rounded-xl inline-flex items-center justify-center shrink-0" style={{ width: 38, height: 38, background: alpha(T.amber, 14), border: `1px solid ${alpha(T.amber, 35)}` }}>
          <Zap size={18} style={{ color: T.amber }} />
        </span>
        <div className="flex flex-col min-w-0 flex-1">
          <h2 className="text-lg font-semibold" style={{ margin: 0, color: T.text }}>Triggers</h2>
          <span className="text-sm" style={{ color: T.text3 }}>What sets each playbook and runbook off, and what each did since the app started.</span>
        </div>
        <label className="flex items-center gap-2 text-xs shrink-0 pt-1" style={{ color: T.text3 }}>
          <Toggle on={showEmpty} onChange={setShowEmpty} /> Show unused events
        </label>
      </header>
      <div className="va-scroll flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-6">
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))' }}>
          <Stat label="Triggers on" value={String(ok.filter((p) => p.enabled).length)} sub={`of ${ok.length}`} />
          <Stat label="Fired this run" value={String(fired)} color={fired ? T.green : undefined} />
          <Stat label="Held back" value={String(held)} sub="matched, but a limit said wait" color={held ? T.amber : undefined} />
          <Stat label="Next scheduled" value={next ? clockTime(next.at.getHours() * 60 + next.at.getMinutes()) : '—'} sub={next ? next.title : 'nothing on a schedule'} />
        </div>

        {GROUPS.map((g) => {
          const events = EVENTS.filter((e) => e.group === g.id).map((e) => ({ e, files: ok.filter((p) => listensTo(p, e.id)) })).filter((x) => showEmpty || x.files.length)
          if (!events.length) return null
          return (
            <div key={g.id} className="flex flex-col gap-3">
              <h3 className="text-[11px] font-medium uppercase" style={{ margin: 0, color: T.text3, letterSpacing: 0.6 }}>{g.label}</h3>
              <div className="flex flex-col gap-4 rounded-xl p-4" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
                {events.map(({ e, files }) => (
                  <Event key={e.id} e={e} files={files} onOpen={(p) => onOpen(p.id)} onToggle={onToggle} onCreate={onCreate} />
                ))}
              </div>
            </div>
          )
        })}

        {unknown.length > 0 && (
          <div className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium uppercase" style={{ margin: 0, color: T.amber, letterSpacing: 0.6 }}>Events this version does not fire</h3>
            {unknown.map((p) => <Row key={p.id} p={p} onOpen={() => onOpen(p.id)} onToggle={(v) => onToggle(p, v)} />)}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-[11px] font-medium uppercase" style={{ margin: 0, color: T.text3, letterSpacing: 0.6 }}>Recent decisions</h3>
          <Log items={activity.slice(0, 40)} onOpen={onOpen} />
        </div>
      </div>
    </section>
  )
}

