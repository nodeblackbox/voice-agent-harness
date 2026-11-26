// The Setup tab: when a playbook or runbook fires (event, phrases, condition, Jev's question), how often it may,
// and what it does. Each control rewrites one field of the file's header, so the file stays the source of truth.
import { CONTEXT_FIELDS, EVENT_FIELDS, KNOWN_EVENTS, field, readPlaybookFile, setPlaybookBody, setPlaybookField, type FieldPath } from '@shared/playbookFile'
import { describeSchedule, type Schedule } from '@shared/schedule'
import { T } from '../../theme'
import { Btn, Toggle } from '../../components/primitives'
import { Area, ChipList, duration, Field, FieldHints, Input, Section } from './parts'
import { DEFAULT_SCHEDULE, EVENT_BY_ID, EVENTS, GROUPS, eventWords } from './events'
import { ScheduleEditor, readSchedule } from './ScheduleEditor'

/** The trigger as one plain sentence, so it is clear what has to be true at once. */
export function describeTrigger(h: Record<string, unknown>, kind: 'playbook' | 'runbook'): string {
  const tr = field.obj(h.triggers)
  const events = field.list(tr.events)
  const ev = events.length ? events : ['turn.user']
  const sched = ev.includes('schedule') ? readSchedule(tr.schedule) : null
  const others = ev.filter((e) => e !== 'schedule')
  const parts: string[] = [
    sched && !others.length
      ? `It runs ${describeSchedule(sched)}`
      : `It fires when ${others.map(eventWords).join(' or ')}${sched ? `, or ${describeSchedule(sched)}` : ''}`
  ]
  const said = field.list(tr.said)
  if (said.length) parts.push(said.length === 1 ? `you use every word of “${said[0]}”` : `you use every word of one of ${said.map((s) => `“${s}”`).join(', ')}`)
  if (field.str(tr.when)) parts.push(`${field.str(tr.when)} is true`)
  const ask = field.obj(tr.ask)
  if (field.str(ask.question)) parts.push(`Jev answers yes to its question`)
  let s = parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join(' and ')
  if (parts.length === 1 && ev.includes('turn.user')) s += `, on every message`
  const gates = field.obj(h.gates)
  const cd = field.num(gates.cooldownS, 0)!
  const max = field.num(gates.maxPerSession)
  const limits: string[] = []
  if (cd > 0) limits.push(`at most once every ${duration(cd)}`)
  if (max) limits.push(`up to ${max} time${max === 1 ? '' : 's'} a session`)
  if (limits.length) s += `; ${limits.join(', ')}`
  return `${s}.${kind === 'runbook' ? ' Then its steps run in the background.' : ' Then its instruction shapes that reply.'}`
}

/** Conditions the picker fills in for an event: replaced when another event is picked, kept once edited. */
const SUGGESTIONS = new Set(EVENTS.map((e) => e.suggest).filter(Boolean) as string[])

export function FormEditor({ text, kind, onChange, onShowFile }: { text: string; kind: 'playbook' | 'runbook'; onChange: (text: string) => void; onShowFile: () => void }) {
  const file = readPlaybookFile(text)
  if (!file.header)
    return (
      <Section title="The file's header can't be read" hint={`${file.problem ?? ''}. Fix it in the File tab and the form comes back.`}>
        <div>
          <Btn small onClick={onShowFile}>
            Open the File tab
          </Btn>
        </div>
      </Section>
    )
  const h = file.header
  const tr = field.obj(h.triggers)
  const gates = field.obj(h.gates)
  const ask = tr.ask && typeof tr.ask === 'object' ? field.obj(tr.ask) : null
  const events = field.list(tr.events)
  const ev = events.length ? events : ['turn.user']
  const userEvent = ev.includes('turn.user')
  const budget = field.obj(h.budget)

  const set = (path: FieldPath, value: unknown) => {
    const out = setPlaybookField(text, path, value)
    if (out !== null) onChange(out)
  }
  const setMany = (pairs: Array<[FieldPath, unknown]>) => {
    let out: string | null = text
    for (const [p, v] of pairs) out = out === null ? null : setPlaybookField(out, p, v)
    if (out !== null) onChange(out)
  }
  const fields: Record<string, string> = userEvent ? { ...CONTEXT_FIELDS } : { tuning: CONTEXT_FIELDS.tuning! }
  for (const e of ev) Object.assign(fields, EVENT_FIELDS[e as keyof typeof EVENT_FIELDS] ?? {})
  const when = field.str(tr.when)
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
  const cooldown = field.num(gates.cooldownS, 0)!
  const pick = (id: string) => {
    const pairs: Array<[FieldPath, unknown]> = [[['triggers', 'events'], [id]]]
    if (id !== 'turn.user') pairs.push([['triggers', 'said'], undefined], [['triggers', 'ask'], undefined])
    pairs.push([['triggers', 'schedule'], id === 'schedule' ? (tr.schedule && typeof tr.schedule === 'object' ? tr.schedule : DEFAULT_SCHEDULE) : undefined])
    const suggest = EVENT_BY_ID[id]?.suggest
    if (!when || SUGGESTIONS.has(when)) pairs.push([['triggers', 'when'], suggest])
    setMany(pairs)
  }
  const sched: Schedule | null = ev.includes('schedule') ? readSchedule(tr.schedule) : null

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl px-4 py-3 text-sm" style={{ background: kind === 'runbook' ? T.cyanTint : T.violetTint, color: T.text, lineHeight: 1.55, border: `1px solid ${kind === 'runbook' ? T.cyanBorder : T.violetBorder}` }} data-testid="trigger-summary">
        {describeTrigger(h, kind)}
      </div>

      <Section title="When it fires" hint="Everything you fill in here has to be true at once. Leave a part empty to skip it.">
        {kind === 'runbook' ? (
          <Field label="On" help="What it reacts to. A playbook only reacts to what you say; runbooks can also react to sessions and the clock.">
            <div className="flex flex-col gap-3" role="radiogroup" aria-label="What it reacts to">
              {GROUPS.map((g) => (
                <div key={g.id} className="flex flex-col gap-1.5">
                  <span className="text-[10.5px] font-medium uppercase" style={{ color: T.text3, letterSpacing: 0.6 }}>
                    {g.label}
                  </span>
                  <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
                    {EVENTS.filter((e) => e.group === g.id).map((c) => {
                      const sel = ev.length === 1 && ev[0] === c.id
                      const Icon = c.icon
                      return (
                        <button
                          key={c.id}
                          type="button"
                          role="radio"
                          aria-checked={sel}
                          aria-pressed={sel}
                          onClick={() => pick(c.id)}
                          className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-left"
                          style={{ cursor: 'pointer', background: sel ? T.cyanTint : T.bg, border: `1px solid ${sel ? T.cyanBorder : T.border}` }}
                        >
                          <Icon size={14} style={{ color: sel ? T.cyan : T.text3, marginTop: 1, flexShrink: 0 }} />
                          <span className="flex flex-col min-w-0">
                            <span className="text-xs font-medium" style={{ color: sel ? T.cyan : T.text }}>
                              {c.label}
                            </span>
                            <span className="text-[11px]" style={{ color: T.text3, lineHeight: 1.4 }}>
                              {c.help}
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
            {!(ev.length === 1 && (KNOWN_EVENTS as readonly string[]).includes(ev[0]!)) && (
              <span className="text-[11px]" style={{ color: T.text3 }}>
                The file lists {ev.join(', ')}. Pick one above to replace it, or keep it as written.
              </span>
            )}
          </Field>
        ) : (
          <Field label="On" help="Playbooks react to what you say or type.">
            <span className="text-sm pt-1" style={{ color: T.text2 }}>
              You say something
            </span>
          </Field>
        )}

        {sched && (
          <Field label="Schedule" help="When it runs. Times of day, a repeat, or both; and the days.">
            <ScheduleEditor value={sched} onChange={(v) => set(['triggers', 'schedule'], v)} />
          </Field>
        )}

        {userEvent && (
          <Field label="Phrases" help="Any one of them, matched on its words in any order. Short and specific works best.">
            <ChipList values={field.list(tr.said)} onChange={(v) => set(['triggers', 'said'], v.length ? v : undefined)} placeholder="e.g. push the changes (Enter to add)" ariaLabel="Add a phrase" />
          </Field>
        )}

        <Field label="Condition" help={userEvent ? 'Optional. Like chars > 1200 or intent == "task".' : 'Optional. Click a field below to use it, e.g. percent >= 80.'}>
          <Input value={when} onChange={(v) => set(['triggers', 'when'], v.trim() ? v : undefined)} placeholder="no condition" mono ariaLabel="Condition" />
          <FieldHints fields={fields} onPick={(n) => set(['triggers', 'when'], when ? `${when} ${n}` : n)} />
        </Field>

        {userEvent && (
          <Field label="Ask Jev" help="A yes/no question about the message, for meaning words can't catch. Costs a call when everything else matches.">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 pt-1">
                <Toggle on={!!ask} onChange={(v) => set(['triggers', 'ask'], v ? { question: 'Is the user asking for this to be done right now?', min: 0.7 } : undefined)} />
                <span className="text-xs" style={{ color: T.text3 }}>
                  {ask ? 'On: it only fires when Jev says yes.' : 'Off'}
                </span>
              </div>
              {ask && (
                <div className="flex flex-col gap-2 rounded-lg p-3" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                  <Area value={field.str(ask.question)} onChange={(v) => set(['triggers', 'ask', 'question'], v)} rows={2} ariaLabel="Jev question" placeholder="Is the user asking for …?" />
                  <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <Input value={field.str(ask.yes)} onChange={(v) => set(['triggers', 'ask', 'yes'], v.trim() ? v : undefined)} placeholder="yes means… (optional)" ariaLabel="Yes means" />
                    <Input value={field.str(ask.no)} onChange={(v) => set(['triggers', 'ask', 'no'], v.trim() ? v : undefined)} placeholder="no means… (optional)" ariaLabel="No means" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs shrink-0" style={{ color: T.text2 }}>
                      Sure enough at
                    </span>
                    <input type="range" aria-label="Jev confidence" min={0.5} max={0.99} step={0.01} value={field.num(ask.min, 0.7)!} onChange={(e) => set(['triggers', 'ask', 'min'], Number(e.target.value))} style={{ flex: 1, accentColor: T.violet }} />
                    <span className="text-xs" style={{ color: T.text2, fontFamily: T.mono, width: 34 }}>
                      {field.num(ask.min, 0.7)!.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </Field>
        )}
      </Section>

      <Section title="How often" hint="Limits that stop it firing again and again.">
        <Field label="Wait between" help="Seconds before it can fire again. 0 = no wait.">
          <div className="flex items-center gap-2">
            <Input type="number" value={String(cooldown)} onChange={(v) => set(['gates', 'cooldownS'], num(v))} width={100} ariaLabel="Cooldown seconds" />
            <span className="text-xs" style={{ color: T.text3 }}>
              {cooldown > 0 ? duration(cooldown) : 'no wait'}
            </span>
          </div>
        </Field>
        <Field label="Per session" help="The most times it fires in one conversation. Empty = no limit.">
          <Input type="number" value={field.num(gates.maxPerSession) === null ? '' : String(field.num(gates.maxPerSession))} onChange={(v) => set(['gates', 'maxPerSession'], num(v))} placeholder="no limit" width={100} ariaLabel="Max per session" />
        </Field>
      </Section>

      {kind === 'runbook' && (
        <Section title="While it runs" hint="What it says when it starts, and the caps on one run.">
          <Field label="When it starts, say" help="A few words, in the reply's own way. Empty = it starts silently.">
            <Input value={field.str(h.ack)} onChange={(v) => set(['ack'], v.trim() ? v : undefined)} placeholder="starts silently" ariaLabel="Acknowledgement" />
          </Field>
          <Field label="At most" help="Steps in one run (1 to 60), and seconds of work, not counting waits for you (5 to 900).">
            <div className="flex items-center gap-2 flex-wrap">
              <Input type="number" value={String(field.num(budget.maxSteps, 15))} onChange={(v) => set(['budget', 'maxSteps'], num(v))} width={80} ariaLabel="Max steps" />
              <span className="text-xs" style={{ color: T.text3 }}>
                steps, and
              </span>
              <Input type="number" value={String(field.num(budget.maxSeconds, 120))} onChange={(v) => set(['budget', 'maxSeconds'], num(v))} width={80} ariaLabel="Max seconds" />
              <span className="text-xs" style={{ color: T.text3 }}>
                seconds ({duration(field.num(budget.maxSeconds, 120)!)})
              </span>
            </div>
          </Field>
        </Section>
      )}

      <Section
        title={kind === 'runbook' ? 'Notes' : 'What the assistant should do'}
        hint={kind === 'runbook' ? 'What this job is for and how it works. Not sent anywhere: it is for you.' : 'Added to the assistant’s instructions for the reply when it fires. Plain words; say what to do and what not to.'}
      >
        <Area value={file.body.replace(/\n$/, '')} onChange={(v) => {
          const out = setPlaybookBody(text, v)
          if (out !== null) onChange(out)
        }} rows={kind === 'runbook' ? 4 : 7} ariaLabel={kind === 'runbook' ? 'Notes' : 'Instruction'} />
      </Section>

      <Section title="Tags" hint="Your own labels, for search.">
        <ChipList values={field.list(h.tags)} onChange={(v) => set(['tags'], v.length ? v : undefined)} placeholder="add a tag (Enter)" ariaLabel="Add a tag" quote={false} />
      </Section>
    </div>
  )
}
