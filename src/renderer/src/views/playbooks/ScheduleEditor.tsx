// The schedule trigger in the form: times of day, an optional repeat inside a window, the days, and the next
// few times it will run, so it is plain when it fires.
import { useState } from 'react'
import { Plus, Repeat, X } from 'lucide-react'
import { DAYS, DAY_NAMES, TIME, clockTime, minutesOf, nextRuns, type Day, type Schedule } from '@shared/schedule'
import { field } from '@shared/playbookFile'
import { T } from '../../theme'
import { Toggle } from '../../components/primitives'

/** The file's schedule as a Schedule (bad values dropped; the Check tab names them). */
export function readSchedule(raw: unknown): Schedule {
  const o = field.obj(raw)
  const time = (v: unknown) => (typeof v === 'string' && TIME.test(v.trim()) ? v.trim() : null)
  return {
    at: field.list(o.at).filter((a) => TIME.test(a.trim())),
    every: field.num(o.every),
    days: field.list(o.days).filter((d): d is Day => (DAYS as readonly string[]).includes(d)),
    from: time(o.from),
    until: time(o.until)
  }
}

/** Only the parts that are set, so the file stays short. */
function tidy(s: Schedule): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (s.at.length) out.at = s.at
  if (s.every) out.every = s.every
  if (s.days.length && s.days.length < 7) out.days = s.days
  if (s.every && s.from) out.from = s.from
  if (s.every && s.until) out.until = s.until
  return out
}

const PRESETS: Array<{ label: string; days: Day[] }> = [
  { label: 'Every day', days: [] },
  { label: 'Weekdays', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
  { label: 'Weekends', days: ['sat', 'sun'] }
]

function when(d: Date, now = new Date()): string {
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'long' })
  return `${day} ${clockTime(d.getHours() * 60 + d.getMinutes())}`
}

const timeInput = { background: T.bg, color: T.text, border: `1px solid ${T.border}`, colorScheme: 'dark light' } as const

export function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (v: Record<string, unknown>) => void }) {
  const [draft, setDraft] = useState('12:00')
  const s = value
  const put = (patch: Partial<Schedule>) => onChange(tidy({ ...s, ...patch }))
  const addTime = () => {
    const m = minutesOf(draft)
    if (m === null) return
    const t = clockTime(m)
    if (!s.at.includes(t)) put({ at: [...s.at, t].sort() })
  }
  const allDays = !s.days.length || s.days.length === 7
  const toggleDay = (d: Day) => {
    const cur = allDays ? [...DAYS] : s.days
    const next = cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]
    put({ days: DAYS.filter((x) => next.includes(x)) })
  }
  const upcoming = nextRuns(s, new Date(), 3)

  return (
    <div className="flex flex-col gap-3 rounded-lg p-3" style={{ background: T.bg, border: `1px solid ${T.border}` }} data-testid="schedule-editor">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: T.text2 }}>At these times</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {s.at.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs" style={{ background: T.cyanTint, color: T.cyan, border: `1px solid ${T.cyanBorder}`, fontFamily: T.mono }}>
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => put({ at: s.at.filter((x) => x !== t) })} style={{ background: 'none', border: 'none', color: T.cyan, cursor: 'pointer', padding: 0, display: 'inline-flex' }}>
                <X size={11} />
              </button>
            </span>
          ))}
          <input type="time" aria-label="Time to add" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTime() } }} className="rounded-md px-1.5 py-0.5 text-xs" style={timeInput} />
          <button type="button" onClick={addTime} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs" style={{ background: T.surface, color: T.text2, border: `1px solid ${T.border}`, cursor: 'pointer' }}>
            <Plus size={11} /> Add time
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Toggle on={!!s.every} onChange={(v) => put({ every: v ? 30 : null })} />
          <Repeat size={12} style={{ color: s.every ? T.cyan : T.text3 }} />
          <span className="text-xs" style={{ color: T.text2 }}>Repeat</span>
          {s.every ? (
            <>
              <span className="text-xs" style={{ color: T.text3 }}>every</span>
              <input type="number" aria-label="Repeat every minutes" min={1} max={1440} value={s.every} onChange={(e) => put({ every: Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 1))) })} className="rounded-md px-1.5 py-0.5 text-xs" style={{ ...timeInput, width: 64 }} />
              <span className="text-xs" style={{ color: T.text3 }}>minutes, from</span>
              <input type="time" aria-label="Repeat from" value={s.from ?? '00:00'} onChange={(e) => put({ from: e.target.value && e.target.value !== '00:00' ? e.target.value : null })} className="rounded-md px-1.5 py-0.5 text-xs" style={timeInput} />
              <span className="text-xs" style={{ color: T.text3 }}>to</span>
              <input type="time" aria-label="Repeat until" value={s.until ?? '23:59'} onChange={(e) => put({ until: e.target.value && e.target.value !== '23:59' ? e.target.value : null })} className="rounded-md px-1.5 py-0.5 text-xs" style={timeInput} />
            </>
          ) : (
            <span className="text-xs" style={{ color: T.text3 }}>off</span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs" style={{ color: T.text2 }}>On</span>
        <div className="flex flex-wrap items-center gap-1">
          {DAYS.map((d) => {
            const on = allDays || s.days.includes(d)
            return (
              <button key={d} type="button" aria-pressed={on} aria-label={DAY_NAMES[d]} onClick={() => toggleDay(d)} className="rounded-md text-xs" style={{ width: 38, height: 26, cursor: 'pointer', background: on ? T.cyanTint : T.surface, color: on ? T.cyan : T.text3, border: `1px solid ${on ? T.cyanBorder : T.border}` }}>
                {DAY_NAMES[d].slice(0, 2)}
              </button>
            )
          })}
          <span style={{ width: 8 }} />
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => put({ days: p.days })} className="rounded-md px-2 text-xs" style={{ height: 26, cursor: 'pointer', background: 'transparent', color: T.text3, border: `1px dashed ${T.border}` }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="text-xs" style={{ color: upcoming.length ? T.text2 : T.amber }} data-testid="next-runs">
        {upcoming.length ? <>Next: {upcoming.map((d) => when(d)).join(' · ')}</> : !s.at.length && !s.every ? 'Add a time or turn on Repeat.' : 'It never comes round: check the days.'}
      </div>
    </div>
  )
}
