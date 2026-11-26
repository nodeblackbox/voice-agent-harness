// Small pieces of the Playbooks page: problem lists, test and review results, runbook runs, and form building blocks.
import { describeSchedule } from '@shared/schedule'
import { eventWords } from './events'
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, CircleAlert, Plus, Sparkles, Square, X } from 'lucide-react'
import type { PlaybookCheck, PlaybookEvalResult, PlaybookEvalRow, PlaybookInfo, PlaybookIssue, PlaybookLabel, PlaybookTestRow, RunbookRun, RunbookRunStatus } from '@shared/types'
import { T, alpha } from '../../theme'
import { Btn } from '../../components/primitives'

export function ago(t: number | null, now = Date.now()): string {
  if (!t) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

export function freeId(base: string, taken: string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'playbook'
  if (!taken.includes(clean)) return clean
  for (let i = 2; ; i++) if (!taken.includes(`${clean}-${i}`)) return `${clean}-${i}`
}

export function duration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return ''
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.round((s / 60) * 10) / 10} min`
  return `${Math.round((s / 3600) * 10) / 10} h`
}

export const issueText = (i: PlaybookIssue): string => (i.line ? `line ${i.line}: ${i.message}` : i.message)

/** What a playbook reacts to, in a few words, for the sidebar. `conditionsOnly`: leave the event out (it is named already). */
export function triggerLine(p: PlaybookInfo, conditionsOnly = false): string {
  const ev = (p.events ?? []).filter((e) => e !== 'turn.user' && (!conditionsOnly || e === 'schedule'))
  const parts: string[] = []
  if (ev.includes('schedule')) parts.push(describeSchedule(p.schedule))
  const others = ev.filter((e) => e !== 'schedule')
  if (others.length) parts.push(others.map(eventWords).join(' or '))
  if (p.said?.length) parts.push(p.said.map((s) => `“${s}”`).join(', '))
  if (p.when) parts.push(p.when)
  if (p.ask) parts.push(`Jev: ${p.ask}`)
  return parts.join(' · ') || (conditionsOnly ? 'every time' : 'every message')
}

// ---- form building blocks ------------------------------------------------------------------

export function Section({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl p-4" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h3 className="text-sm font-semibold" style={{ margin: 0, color: T.text }}>
            {title}
          </h3>
          {hint && (
            <p className="text-xs" style={{ margin: 0, color: T.text3, lineHeight: 1.5 }}>
              {hint}
            </p>
          )}
        </div>
        {right}
      </div>
      {children}
    </section>
  )
}

export function Field({ label, help, children, wide }: { label: string; help?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? 'flex flex-col gap-1.5' : 'grid gap-3 items-start'} style={wide ? undefined : { gridTemplateColumns: '170px minmax(0, 1fr)' }}>
      <div className="flex flex-col gap-0.5 pt-1.5">
        <span className="text-xs font-medium" style={{ color: T.text2 }}>
          {label}
        </span>
        {help && !wide && (
          <span className="text-[11px]" style={{ color: T.text3, lineHeight: 1.45 }}>
            {help}
          </span>
        )}
      </div>
      <div className="min-w-0 flex flex-col gap-1">
        {children}
        {help && wide && (
          <span className="text-[11px]" style={{ color: T.text3, lineHeight: 1.45 }}>
            {help}
          </span>
        )}
      </div>
    </div>
  )
}

const inputStyle = (mono?: boolean, bad?: boolean) => ({ color: T.text, background: T.bg, border: `1px solid ${bad ? T.red : T.border}`, fontFamily: mono ? T.mono : undefined, outline: 'none' })

export function Input({ value, onChange, placeholder, mono, bad, ariaLabel, type = 'text', width }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; bad?: boolean; ariaLabel?: string; type?: 'text' | 'number'; width?: number }) {
  return (
    <input
      aria-label={ariaLabel}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="rounded-lg px-2.5 py-1.5 text-sm"
      style={{ ...inputStyle(mono, bad), width: width ?? '100%' }}
    />
  )
}

export function Area({ value, onChange, placeholder, rows = 4, mono, ariaLabel }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number; mono?: boolean; ariaLabel?: string }) {
  return (
    <textarea
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={Math.min(12, Math.max(rows, value.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 80)), 0)))}
      className="w-full rounded-lg px-3 py-2 text-sm"
      style={{ ...inputStyle(mono), lineHeight: 1.55, resize: 'vertical' }}
    />
  )
}

/** A list of short phrases as removable chips, with a box to add one (Enter). */
export function ChipList({ values, onChange, placeholder, ariaLabel, quote = true }: { values: string[]; onChange: (v: string[]) => void; placeholder: string; ariaLabel: string; quote?: boolean }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const v = draft.trim()
    if (v && !values.includes(v)) onChange([...values, v])
    setDraft('')
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg px-2 py-1.5" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs" style={{ background: T.violetTint, color: T.violet, border: `1px solid ${T.violetBorder}` }}>
          {quote ? `“${v}”` : v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} style={{ background: 'none', border: 'none', color: T.violet, cursor: 'pointer', padding: 0, display: 'inline-flex' }}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        placeholder={values.length ? 'add another…' : placeholder}
        className="flex-1 text-sm bg-transparent"
        style={{ minWidth: 140, border: 'none', outline: 'none', color: T.text }}
      />
      {draft.trim() && (
        <button type="button" onClick={add} aria-label="Add phrase" style={{ background: 'none', border: 'none', color: T.text2, cursor: 'pointer', display: 'inline-flex' }}>
          <Plus size={13} />
        </button>
      )}
    </div>
  )
}

/** Clickable field names that put `name` into a condition box. */
export function FieldHints({ fields, onPick }: { fields: Record<string, string>; onPick: (name: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {Object.entries(fields).map(([k, v]) => (
        <button key={k} type="button" title={v} onClick={() => onPick(k)} className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: T.raised, color: T.text2, border: 'none', cursor: 'pointer', fontFamily: T.mono }}>
          {k}
        </button>
      ))}
    </div>
  )
}

// ---- results -------------------------------------------------------------------------------

export function Issues({ check, compact }: { check: PlaybookCheck | null; compact?: boolean }) {
  if (!check) return null
  const rows = [...check.errors.map((i) => ({ ...i, bad: true })), ...check.warnings.map((i) => ({ ...i, bad: false }))]
  if (!rows.length)
    return compact ? null : (
      <div className="flex items-center gap-1.5 text-xs" style={{ color: T.green }}>
        <Check size={12} /> The file loads without problems.
      </div>
    )
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs rounded-md px-2 py-1.5" style={{ background: r.bad ? T.redTint : T.amberTint, color: T.text, lineHeight: 1.45 }}>
          {r.bad ? <CircleAlert size={12} style={{ color: T.red, flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={12} style={{ color: T.amber, flexShrink: 0, marginTop: 2 }} />}
          {r.line > 0 && (
            <span className="shrink-0" style={{ color: T.text3, fontFamily: T.mono }}>
              line {r.line}
            </span>
          )}
          <span>{r.message}</span>
        </div>
      ))}
    </div>
  )
}

const VERDICT: Record<PlaybookEvalRow['verdict'], { label: string; color: string }> = {
  agree: { label: 'right', color: T.green },
  miss: { label: 'missed', color: T.amber },
  false_fire: { label: 'fired wrongly', color: T.red },
  unsure: { label: 'unsure', color: T.text3 }
}

/** With a mark set or cleared, what the row now says (the mark beats the judge; clearing it leaves "unsure" until the next review). */
export function withLabel(r: PlaybookEvalRow, label: PlaybookLabel | null): PlaybookEvalRow {
  const should = label ? label === 'should' : r.by === 'label' ? null : r.should
  const verdict: PlaybookEvalRow['verdict'] = should === null ? 'unsure' : should === r.fires ? 'agree' : r.fires ? 'false_fire' : 'miss'
  return { ...r, label: label ?? undefined, should, by: label ? 'label' : r.by === 'label' ? 'none' : r.by, verdict }
}

const panel = { background: T.bg, border: `1px solid ${T.border}` }
const clamp2 = { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' }

export function ReviewPanel({ result, canMark, onMark, onSuggest, suggesting, onClose }: { result: PlaybookEvalResult; canMark: boolean; onMark: (row: PlaybookEvalRow, label: PlaybookLabel | null) => void; onSuggest: () => void; suggesting: boolean; onClose: () => void }) {
  const [all, setAll] = useState(false)
  const s = result.summary
  const problems = result.rows.filter((r) => r.verdict === 'miss' || r.verdict === 'false_fire')
  const shown = all ? result.rows : result.rows.filter((r) => r.verdict !== 'agree')
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3" style={panel}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs font-medium" style={{ color: T.text2 }}>
          {s.checked ? `Of your last ${s.checked} messages it fires on ${s.fires}. Right on ${s.agree}` : 'No messages to review yet'}
          {s.misses ? <span style={{ color: T.amber }}>, missed {s.misses}</span> : null}
          {s.falseFires ? <span style={{ color: T.red }}>, fired wrongly on {s.falseFires}</span> : null}
          {s.unsure ? <span style={{ color: T.text3 }}>, unsure about {s.unsure}</span> : null}
          {s.checked ? '.' : ''}
        </span>
        <div className="flex gap-1">
          {problems.length > 0 && (
            <Btn small primary icon={Sparkles} onClick={onSuggest} disabled={suggesting}>
              {suggesting ? 'Drafting…' : 'Suggest a tighter trigger'}
            </Btn>
          )}
          <Btn small onClick={() => setAll(!all)}>
            {all ? 'Problems only' : 'Show all'}
          </Btn>
          <Btn small onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
      {result.note && (
        <span className="text-xs" style={{ color: T.text3, lineHeight: 1.45 }}>
          {result.note} Your own marks count over the judge.
        </span>
      )}
      {shown.length === 0 && (
        <span className="text-xs" style={{ color: T.green }}>
          Nothing to fix: wherever the judge was sure, the trigger did the right thing.
        </span>
      )}
      {shown.map((r) => {
        const v = VERDICT[r.verdict]
        return (
          <div key={r.messageId} className="flex items-start gap-2 text-xs" style={{ lineHeight: 1.45 }}>
            <span className="shrink-0 rounded px-1.5 py-0.5" style={{ background: alpha(v.color, 14), color: v.color, minWidth: 82, textAlign: 'center' }}>
              {v.label}
            </span>
            <div className="min-w-0 flex-1 flex flex-col gap-0.5">
              <span style={{ color: T.text, ...clamp2 }}>{r.text}</span>
              <span style={{ color: T.text3 }}>
                {r.fires ? 'fires' : 'does not fire'} ·{' '}
                {r.by === 'label' ? `you marked it ${r.label === 'should' ? 'should fire' : 'should not fire'}` : r.should === null ? 'judge unsure' : `${r.by === 'jev' ? 'Jev' : 'the model'} says it ${r.should ? 'should' : 'should not'}${r.p !== null ? ` (${r.p.toFixed(2)})` : ''}`}
              </span>
            </div>
            {canMark && (
              <div className="flex gap-1 shrink-0">
                {(['should', 'should_not'] as const).map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => onMark(r, r.label === l ? null : l)}
                    className="rounded px-1.5 py-0.5 text-[11px]"
                    title={r.label === l ? 'Clear your mark' : l === 'should' ? 'It should fire on this message' : 'It should not fire on this message'}
                    style={{ cursor: 'pointer', border: `1px solid ${r.label === l ? T.cyanBorder : T.border}`, background: r.label === l ? T.cyanTint : 'transparent', color: r.label === l ? T.cyan : T.text2 }}
                  >
                    {l === 'should' ? 'Should fire' : "Shouldn't"}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function TestResults({ rows, note, onClose }: { rows: PlaybookTestRow[]; note?: string; onClose: () => void }) {
  const [all, setAll] = useState(false)
  const hits = rows.filter((r) => r.why)
  const shown = all ? rows : hits
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3" style={panel}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium" style={{ color: T.text2 }}>
          {rows.length ? `${hits.length} of your last ${rows.length} messages would have set it off` : 'No messages to test against yet'}
          <span style={{ color: T.text3, fontWeight: 400 }}> · on/off and cooldowns are not applied</span>
        </span>
        <div className="flex gap-1">
          {rows.length > hits.length && (
            <Btn small onClick={() => setAll(!all)}>
              {all ? 'Matches only' : 'Show all'}
            </Btn>
          )}
          <Btn small onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
      {note && (
        <span className="text-xs" style={{ color: T.text3, lineHeight: 1.45 }}>
          {note}
        </span>
      )}
      {shown.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs" style={{ lineHeight: 1.45 }}>
          <span className="shrink-0 mt-1 rounded-full" style={{ width: 7, height: 7, background: r.why ? T.green : T.border }} />
          <div className="min-w-0 flex flex-col gap-0.5">
            <span style={{ color: r.why ? T.text : T.text3, ...clamp2 }}>{r.text}</span>
            {r.why && <span style={{ color: T.violet, fontFamily: T.mono }}>{r.why}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

export const RUN_STATUS: Record<RunbookRunStatus, { label: string; color: string }> = {
  running: { label: 'working', color: T.cyan },
  waiting: { label: 'waiting for your reply', color: T.amber },
  done: { label: 'done', color: T.green },
  blocked: { label: 'stopped by an error', color: T.red },
  out_of_budget: { label: 'hit its limit', color: T.amber },
  cancelled: { label: 'cancelled', color: T.text3 },
  expired: { label: 'no reply in time', color: T.text3 },
  interrupted: { label: 'cut off when the app closed', color: T.text3 }
}

export function RunRow({ run, onCancel, showTitle }: { run: RunbookRun; onCancel: () => void; showTitle?: boolean }) {
  const [open, setOpen] = useState(false)
  const st = RUN_STATUS[run.status]
  const active = run.status === 'running' || run.status === 'waiting'
  return (
    <div className="rounded-lg px-3 py-2 flex flex-col gap-1.5" style={panel}>
      <div className="flex items-center gap-2 text-xs">
        <span className={`rounded-full shrink-0 ${run.status === 'running' ? 'va-pulse' : ''}`} style={{ width: 7, height: 7, background: st.color }} />
        {showTitle && <span style={{ color: T.text, fontWeight: 500 }}>{run.title}</span>}
        <span style={{ color: st.color }}>{st.label}</span>
        <span style={{ color: T.text3 }}>
          · {run.steps} step{run.steps === 1 ? '' : 's'} · {ago(run.startedAt)}
        </span>
        <div className="flex-1" />
        {run.log.length > 0 && (
          <button type="button" onClick={() => setOpen(!open)} className="text-xs" style={{ color: T.text2, background: 'none', border: 'none', cursor: 'pointer' }}>
            {open ? 'Hide steps' : 'Steps'}
          </button>
        )}
        {active && (
          <Btn small icon={Square} onClick={onCancel}>
            Cancel
          </Btn>
        )}
      </div>
      {run.waiting?.question && (
        <span className="text-xs" style={{ color: T.text2, lineHeight: 1.45, ...clamp2 }}>
          Asked: “{run.waiting.question}”
        </span>
      )}
      {run.reason && run.status !== 'done' && (
        <span className="text-xs" style={{ color: T.text3, lineHeight: 1.45 }}>
          {run.reason}
        </span>
      )}
      {open && (
        <div className="flex flex-col gap-0.5">
          {run.log.map((l, i) => (
            <div key={i} className="flex gap-2 text-[11px]" style={{ fontFamily: T.mono, color: l.outcome === 'ok' ? T.text2 : T.red }}>
              <span style={{ color: T.text3, minWidth: 52 }}>{l.ms >= 1000 ? `${(l.ms / 1000).toFixed(1)} s` : `${l.ms} ms`}</span>
              <span>
                {l.step} ({l.kind}){l.note ? `: ${l.note}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
