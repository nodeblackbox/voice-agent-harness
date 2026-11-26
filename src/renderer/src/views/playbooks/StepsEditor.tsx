// The Steps tab of a runbook: one card per step with the fields its kind takes, reorder and delete, add a step by
// kind, and the flowchart of the steps drawn live beside them. Every change rewrites just that part of the file.
import { useEffect, useState, type ComponentType } from 'react'
import { ArrowDown, ArrowUp, Bot, GitBranch, Hourglass, Megaphone, MessageCircle, Plus, Sparkles, Trash2, Wrench, X } from 'lucide-react'
import { EVENT_FIELDS, RUNBOOK_TOOLS, field, readPlaybookFile, setPlaybookField, type FieldPath } from '@shared/playbookFile'
import { InlineDiagram } from '../../components/diagram/DiagramCard'
import { T, alpha } from '../../theme'
import { Btn, Toggle } from '../../components/primitives'
import { Area, duration, Field, Input, Section } from './parts'

type Kind = 'model' | 'check' | 'ask' | 'say' | 'wait' | 'tool' | 'claude'
type Raw = Record<string, unknown>

export const STEP_KINDS: Record<Kind, { label: string; what: string; icon: ComponentType<{ size?: number; style?: React.CSSProperties }>; color: string }> = {
  model: { label: 'Think', what: 'Ask the model something and save its answer', icon: Sparkles, color: T.violet },
  check: { label: 'Check', what: 'Branch on a condition', icon: GitBranch, color: T.amber },
  ask: { label: 'Ask you', what: 'Ask you a question out loud and branch on the answer', icon: MessageCircle, color: T.cyan },
  say: { label: 'Say', what: 'Tell you something', icon: Megaphone, color: T.green },
  wait: { label: 'Wait', what: 'Wait for your next reply', icon: Hourglass, color: T.text2 },
  tool: { label: 'Tool', what: 'Look something up, remember or draw', icon: Wrench, color: T.cyan },
  claude: { label: 'Claude Code', what: 'Start a Claude Code session, or message one', icon: Bot, color: T.claude }
}

const TEMPLATES: Record<Kind, (id: string) => Raw> = {
  model: (id) => ({ id, do: 'model', prompt: 'Read this and say what matters most, in one line: {{text}}', save: `${id}_out` }),
  check: (id) => ({ id, do: 'check', if: 'text != ""', next: { yes: 'end', no: 'end' } }),
  ask: (id) => ({ id, do: 'ask', question: 'Shall I go ahead with this?', next: { yes: 'end', no: 'end' } }),
  say: (id) => ({ id, do: 'say', text: 'All done.' }),
  wait: (id) => ({ id, do: 'wait', save: 'reply', expireS: 180 }),
  tool: (id) => ({ id, do: 'tool', tool: 'remember', args: { key: 'Note: {{text}}', value: '{{text}}', kind: 'todo' } }),
  claude: (id) => ({ id, do: 'claude', name: 'helper', prompt: 'Do this, then say what you changed: {{text}}', folder: 'sandbox' })
}

const isKind = (k: unknown): k is Kind => typeof k === 'string' && k in STEP_KINDS

function freeStepId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}${i}`)) return `${base}${i}`
}

/** Where a branch goes: the next step in the list (no value), another step, or "end". */
function NextSelect({ value, ids, self, last, onChange, label }: { value: string | undefined; ids: string[]; self: string; last: boolean; onChange: (v: string | undefined) => void; label: string }) {
  const known = value === undefined || value === 'end' || ids.includes(value)
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className="rounded-lg px-2 py-1.5 text-sm"
      style={{ background: T.bg, color: known ? T.text : T.red, border: `1px solid ${known ? T.border : T.red}`, outline: 'none', minWidth: 160 }}
    >
      <option value="">{last ? 'stop (last step)' : 'the next step'}</option>
      {ids
        .filter((id) => id !== self)
        .map((id) => (
          <option key={id} value={id}>
            go to {id}
          </option>
        ))}
      <option value="end">stop here</option>
      {!known && <option value={value}>{value} (not a step)</option>}
    </select>
  )
}

/** The {{names}} a step can use: the message, what earlier steps saved, and the event's fields. */
function Vars({ names, onPick }: { names: string[]; onPick: (n: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[11px]" style={{ color: T.text3 }}>
        Insert:
      </span>
      {names.map((n) => (
        <button key={n} type="button" onClick={() => onPick(n)} className="rounded px-1.5 py-px text-[11px]" style={{ background: T.raised, color: T.text2, border: 'none', cursor: 'pointer', fontFamily: T.mono }}>
          {`{{${n}}}`}
        </button>
      ))}
    </div>
  )
}

function IdInput({ value, onCommit, bad }: { value: string; onCommit: (v: string) => void; bad: boolean }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  const commit = () => {
    const clean = v.trim()
    if (clean && clean !== value) onCommit(clean)
    else setV(value)
  }
  return (
    <input
      aria-label="Step id"
      value={v}
      onChange={(e) => setV(e.target.value.toLowerCase().replace(/\s+/g, '_'))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') setV(value)
      }}
      title="The step's name: other steps go to it by this name. Renaming it updates them too."
      className="rounded-md px-1.5 py-0.5 text-sm"
      style={{ background: 'transparent', color: T.text, border: `1px solid ${bad ? T.red : 'transparent'}`, fontFamily: T.mono, outline: 'none', width: 150 }}
      onFocus={(e) => (e.currentTarget.style.borderColor = T.border)}
    />
  )
}

/** Choice options of an ask step (key -> what it means); none = a yes/no question. */
function Options({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string> | undefined) => void }) {
  const rows = Object.entries(value)
  const [key, setKey] = useState('')
  const [meaning, setMeaning] = useState('')
  const add = () => {
    const k = key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
    if (!k || !meaning.trim() || !/^[a-z]/.test(k)) return
    onChange({ ...value, [k]: meaning.trim() })
    setKey('')
    setMeaning('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([k, m]) => (
        <div key={k} className="flex items-center gap-2">
          <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: T.cyanTint, color: T.cyan, fontFamily: T.mono, minWidth: 70 }}>
            {k}
          </span>
          <Input value={m} onChange={(v) => onChange({ ...value, [k]: v })} ariaLabel={`Meaning of ${k}`} />
          <button
            type="button"
            aria-label={`Remove option ${k}`}
            onClick={() => {
              const next = { ...value }
              delete next[k]
              onChange(Object.keys(next).length ? next : undefined)
            }}
            style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', display: 'inline-flex' }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input value={key} onChange={setKey} placeholder="answer, e.g. later" ariaLabel="New option" mono width={130} />
        <Input value={meaning} onChange={setMeaning} placeholder="what it means, e.g. the user wants it done another time" ariaLabel="New option meaning" />
        <Btn small icon={Plus} onClick={add} disabled={!key.trim() || !meaning.trim()}>
          Add
        </Btn>
      </div>
    </div>
  )
}

/** Args of a tool step as name/value rows. Values that are not text are shown and read back as JSON. */
function Args({ value, onChange }: { value: Raw; onChange: (v: Raw) => void }) {
  const [name, setName] = useState('')
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))
  const read = (s: string): unknown => {
    if (/^(true|false|null|-?\d+(\.\d+)?|\[.*\]|\{.*\})$/.test(s.trim())) {
      try {
        return JSON.parse(s)
      } catch {
        return s
      }
    }
    return s
  }
  return (
    <div className="flex flex-col gap-1.5">
      {Object.entries(value).map(([k, v]) => (
        <div key={k} className="flex items-center gap-2">
          <span className="text-xs shrink-0" style={{ color: T.text2, fontFamily: T.mono, minWidth: 70 }}>
            {k}
          </span>
          <Input value={show(v)} onChange={(s) => onChange({ ...value, [k]: read(s) })} ariaLabel={`Argument ${k}`} mono />
          <button
            type="button"
            aria-label={`Remove argument ${k}`}
            onClick={() => {
              const next = { ...value }
              delete next[k]
              onChange(next)
            }}
            style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', display: 'inline-flex' }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Input value={name} onChange={(s) => setName(s.replace(/\s+/g, ''))} placeholder="add an argument" ariaLabel="New argument" mono width={160} />
        <Btn
          small
          icon={Plus}
          disabled={!name || name in value}
          onClick={() => {
            onChange({ ...value, [name]: '' })
            setName('')
          }}
        >
          Add
        </Btn>
      </div>
    </div>
  )
}

function StepCard({
  step,
  index,
  count,
  ids,
  vars,
  set,
  onMove,
  onRemove,
  onRename
}: {
  step: Raw
  index: number
  count: number
  ids: string[]
  vars: string[]
  set: (key: FieldPath, value: unknown) => void
  onMove: (dir: -1 | 1) => void
  onRemove: () => void
  onRename: (to: string) => void
}) {
  const kind = isKind(step.do) ? step.do : null
  const meta = kind ? STEP_KINDS[kind] : null
  const id = field.str(step.id)
  const last = index === count - 1
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(t)
  }, [confirm])
  const str = (k: string) => field.str(step[k])
  const opt = (k: string, v: string) => set([k], v.trim() ? v : undefined)
  const insert = (k: string) => (n: string) => set([k], `${str(k)}${str(k) && !str(k).endsWith(' ') ? ' ' : ''}{{${n}}}`)
  const next = (label = 'Then') => (
    <Field label={label} help="Without a choice it goes on to the next step in the list.">
      <NextSelect label={`${id} next`} value={typeof step.next === 'string' ? step.next : undefined} ids={ids} self={id} last={last} onChange={(v) => set(['next'], v)} />
    </Field>
  )
  const branches = (keys: string[]) => {
    const nx = field.obj(step.next)
    return (
      <Field label="Then" help="Where each answer goes.">
        <div className="flex flex-col gap-1.5">
          {keys.map((k) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-xs rounded px-1.5 py-0.5" style={{ background: T.raised, color: T.text2, fontFamily: T.mono, minWidth: 70, textAlign: 'center' }}>
                {k}
              </span>
              <span className="text-xs" style={{ color: T.text3 }}>
                →
              </span>
              <NextSelect label={`${id} ${k}`} value={typeof nx[k] === 'string' ? (nx[k] as string) : undefined} ids={ids} self={id} last={last} onChange={(v) => set(['next', k], v ?? (last ? 'end' : ids[index + 1]))} />
            </div>
          ))}
        </div>
      </Field>
    )
  }

  return (
    <div className="rounded-xl flex flex-col va-fade" data-step={id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderLeft: `3px solid ${meta?.color ?? T.red}` }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: `1px solid ${T.border}` }}>
        <span className="text-[11px] rounded-full inline-flex items-center justify-center shrink-0" style={{ width: 20, height: 20, background: T.raised, color: T.text2, fontFamily: T.mono }}>
          {index + 1}
        </span>
        {meta && (
          <span className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 shrink-0" style={{ background: alpha(meta.color, 14), color: meta.color }} title={meta.what}>
            <meta.icon size={12} /> {meta.label}
          </span>
        )}
        <IdInput value={id} onCommit={onRename} bad={ids.filter((x) => x === id).length > 1} />
        <div className="flex-1" />
        <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} style={{ background: 'none', border: 'none', color: index === 0 ? T.border : T.text2, cursor: index === 0 ? 'default' : 'pointer', display: 'inline-flex', padding: 3 }}>
          <ArrowUp size={14} />
        </button>
        <button type="button" aria-label="Move down" disabled={last} onClick={() => onMove(1)} style={{ background: 'none', border: 'none', color: last ? T.border : T.text2, cursor: last ? 'default' : 'pointer', display: 'inline-flex', padding: 3 }}>
          <ArrowDown size={14} />
        </button>
        <button
          type="button"
          aria-label={confirm ? 'Click again to remove the step' : 'Remove step'}
          onClick={() => (confirm ? onRemove() : setConfirm(true))}
          className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5"
          style={{ background: confirm ? T.redTint : 'none', border: 'none', color: confirm ? T.red : T.text3, cursor: 'pointer' }}
        >
          <Trash2 size={13} /> {confirm ? 'Remove?' : ''}
        </button>
      </div>

      <div className="flex flex-col gap-3 p-3">
        {!kind && (
          <span className="text-xs" style={{ color: T.red }}>
            This step's kind ({String(step.do ?? 'missing')}) is not one of {Object.keys(STEP_KINDS).join(', ')}. Fix it in the File tab.
          </span>
        )}

        {kind === 'model' && (
          <>
            <Field label="Prompt" help="What to ask the model. {{name}} puts in a value." wide>
              <Area value={str('prompt')} onChange={(v) => set(['prompt'], v)} rows={3} ariaLabel={`${id} prompt`} />
              <Vars names={vars} onPick={insert('prompt')} />
            </Field>
            <Field label="Save the answer as" help="Later steps use it as {{name}}.">
              <Input value={str('save')} onChange={(v) => set(['save'], v)} mono width={200} ariaLabel={`${id} save`} />
            </Field>
            <Field label="Split into a list" help={`One item per line; also saves ${str('save') || 'name'}_count.`}>
              <div className="pt-1">
                <Toggle on={field.bool(step.list)} onChange={(v) => set(['list'], v || undefined)} />
              </div>
            </Field>
            {next()}
          </>
        )}

        {kind === 'check' && (
          <>
            <Field label="If" help="A condition on saved values, like tasks_count > 0 or reply != &quot;&quot;.">
              <Input value={str('if')} onChange={(v) => set(['if'], v)} mono ariaLabel={`${id} condition`} />
            </Field>
            {branches(['yes', 'no'])}
          </>
        )}

        {kind === 'ask' && (
          <>
            <Field label="Question" help="Said out loud; Jev reads your answer." wide>
              <Area value={str('question')} onChange={(v) => set(['question'], v)} rows={2} ariaLabel={`${id} question`} />
              <Vars names={vars} onPick={insert('question')} />
            </Field>
            <Field label="Answers" help="None: a yes/no question. Add options for a choice.">
              <Options value={Object.fromEntries(Object.entries(field.obj(step.options)).filter(([, v]) => typeof v === 'string')) as Record<string, string>} onChange={(v) => set(['options'], v)} />
            </Field>
            {branches(Object.keys(field.obj(step.options)).length ? Object.keys(field.obj(step.options)) : ['yes', 'no'])}
            <Field label="Sure enough at" help="How sure Jev must be before it acts on the answer.">
              <div className="flex items-center gap-3 pt-1">
                <input type="range" aria-label={`${id} min`} min={0.5} max={0.99} step={0.01} value={field.num(step.min, 0.6)!} onChange={(e) => set(['min'], Number(e.target.value))} style={{ flex: 1, accentColor: T.cyan }} />
                <span className="text-xs" style={{ color: T.text2, fontFamily: T.mono, width: 34 }}>
                  {field.num(step.min, 0.6)!.toFixed(2)}
                </span>
              </div>
            </Field>
            <Field label="Save the answer as" help="Optional.">
              <Input value={str('save')} onChange={(v) => opt('save', v)} mono width={200} ariaLabel={`${id} save`} />
            </Field>
          </>
        )}

        {kind === 'say' && (
          <>
            <Field label="Say" help="Spoken in the chat, in the assistant's voice." wide>
              <Area value={str('text')} onChange={(v) => set(['text'], v)} rows={2} ariaLabel={`${id} text`} />
              <Vars names={vars} onPick={insert('text')} />
            </Field>
            {next()}
          </>
        )}

        {kind === 'wait' && (
          <>
            <Field label="Save the reply as" help="Default reply.">
              <Input value={str('save')} onChange={(v) => opt('save', v)} placeholder="reply" mono width={200} ariaLabel={`${id} save`} />
            </Field>
            <Field label="Give up after" help="Seconds without a reply (10 to 86400).">
              <div className="flex items-center gap-2">
                <Input type="number" value={String(field.num(step.expireS, 180))} onChange={(v) => set(['expireS'], v === '' ? undefined : Number(v))} width={100} ariaLabel={`${id} expire`} />
                <span className="text-xs" style={{ color: T.text3 }}>
                  {duration(field.num(step.expireS, 180)!)}
                </span>
              </div>
            </Field>
            {next()}
          </>
        )}

        {kind === 'tool' && (
          <>
            <Field label="Tool" help="Only tools that look up, remember or draw: a runbook cannot change your files.">
              <select
                aria-label={`${id} tool`}
                value={str('tool')}
                onChange={(e) => set(['tool'], e.target.value)}
                className="rounded-lg px-2 py-1.5 text-sm"
                style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, outline: 'none', width: 220, fontFamily: T.mono }}
              >
                {!RUNBOOK_TOOLS.includes(str('tool') as (typeof RUNBOOK_TOOLS)[number]) && <option value={str('tool')}>{str('tool') || 'pick a tool'}</option>}
                {RUNBOOK_TOOLS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Arguments" help="{{name}} works in values.">
              <Args value={field.obj(step.args)} onChange={(v) => set(['args'], v)} />
            </Field>
            <Field label="Once per item of" help="A saved list; {{item}} is each one. Leave empty to run once.">
              <Input value={str('each')} onChange={(v) => opt('each', v)} mono width={200} ariaLabel={`${id} each`} />
            </Field>
            <Field label="Save the result as" help="Optional.">
              <Input value={str('save')} onChange={(v) => opt('save', v)} mono width={200} ariaLabel={`${id} save`} />
            </Field>
            {next()}
          </>
        )}

        {kind === 'claude' && (
          <>
            <Field label="Session" help="Empty: start a new one. Or message an existing one by name, or {{sessionId}} from the event.">
              <Input value={str('session')} onChange={(v) => opt('session', v)} placeholder="a new session" mono ariaLabel={`${id} session`} />
            </Field>
            {!str('session') && (
              <Field label="Name" help="Easy to say: you will refer to it by voice.">
                <Input value={str('name')} onChange={(v) => opt('name', v)} width={240} ariaLabel={`${id} name`} />
              </Field>
            )}
            <Field label="Prompt" help="What Claude Code should do." wide>
              <Area value={str('prompt')} onChange={(v) => set(['prompt'], v)} rows={3} ariaLabel={`${id} prompt`} />
              <Vars names={vars} onPick={insert('prompt')} />
            </Field>
            {!str('session') && (
              <Field label="Works in" help="A fresh folder of its own, or this app's own source.">
                <div className="flex gap-1">
                  {(['sandbox', 'app'] as const).map((f) => {
                    const sel = (str('folder') || 'sandbox') === f
                    return (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={sel}
                        onClick={() => set(['folder'], f)}
                        className="rounded-lg px-2.5 py-1 text-xs"
                        style={{ cursor: 'pointer', background: sel ? T.cyanTint : 'transparent', color: sel ? T.cyan : T.text2, border: `1px solid ${sel ? T.cyanBorder : T.border}` }}
                      >
                        {f === 'sandbox' ? 'Its own folder' : "This app's source"}
                      </button>
                    )
                  })}
                </div>
              </Field>
            )}
            {next()}
          </>
        )}
      </div>
    </div>
  )
}

export function StepsEditor({ text, onChange, diagram, stale, onShowFile }: { text: string; onChange: (text: string) => void; diagram: string | null; stale: boolean; onShowFile: () => void }) {
  const file = readPlaybookFile(text)
  if (!file.header)
    return (
      <Section title="The file's header can't be read" hint={`${file.problem ?? ''}. Fix it in the File tab and the steps come back here.`}>
        <div>
          <Btn small onClick={onShowFile}>
            Open the File tab
          </Btn>
        </div>
      </Section>
    )
  const steps = (Array.isArray(file.header.steps) ? file.header.steps : []).map((s) => field.obj(s))
  const ids = steps.map((s) => field.str(s.id))
  const events = field.list(field.obj(file.header.triggers).events)
  const eventVars = events.flatMap((e) => Object.keys(EVENT_FIELDS[e as keyof typeof EVENT_FIELDS] ?? {}))

  const write = (path: FieldPath, value: unknown) => {
    const out = setPlaybookField(text, path, value)
    if (out !== null) onChange(out)
  }
  const writeAll = (next: Raw[]) => write(['steps'], next)
  const varsAt = (i: number) => {
    const saved = steps.slice(0, i).flatMap((s) => {
      const name = field.str(s.save, s.do === 'wait' ? 'reply' : '')
      return name ? (s.list ? [name, `${name}_count`] : [name]) : []
    })
    const each = steps[i]?.each ? ['item'] : []
    return [...new Set([...(events.includes('turn.user') || !events.length ? ['text'] : []), ...eventVars, ...saved, ...each])]
  }

  const rename = (i: number, to: string) => {
    const from = ids[i]!
    const next = steps.map((s, j) => {
      const copy: Raw = { ...s }
      if (j === i) copy.id = to
      if (copy.next === from) copy.next = to
      else if (copy.next && typeof copy.next === 'object') copy.next = Object.fromEntries(Object.entries(copy.next as Raw).map(([k, v]) => [k, v === from ? to : v]))
      return copy
    })
    writeAll(next)
  }
  const move = (i: number, dir: -1 | 1) => {
    const next = [...steps]
    const [s] = next.splice(i, 1)
    next.splice(i + dir, 0, s!)
    writeAll(next)
  }
  const add = (kind: Kind) => writeAll([...steps, TEMPLATES[kind](freeStepId(kind === 'model' ? 'think' : kind, ids))])

  return (
    <div className="grid gap-4 items-start" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 380px)' }}>
      <div className="flex flex-col gap-3 min-w-0">
        {steps.length === 0 && (
          <div className="rounded-xl px-4 py-6 text-center text-sm" style={{ border: `1px dashed ${T.border}`, color: T.text3 }}>
            No steps yet. A runbook needs at least one: pick a kind below.
          </div>
        )}
        {steps.map((s, i) => (
          <StepCard
            key={`${i}-${ids[i]}`}
            step={s}
            index={i}
            count={steps.length}
            ids={ids}
            vars={varsAt(i)}
            set={(path, v) => write(['steps', i, ...path], v)}
            onMove={(d) => move(i, d)}
            onRemove={() => writeAll(steps.filter((_, j) => j !== i))}
            onRename={(to) => rename(i, to)}
          />
        ))}
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ border: `1px dashed ${T.border}` }}>
          <span className="text-xs font-medium" style={{ color: T.text2 }}>
            Add a step
          </span>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
            {(Object.keys(STEP_KINDS) as Kind[]).map((k) => {
              const m = STEP_KINDS[k]
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => add(k)}
                  title={m.what}
                  className="flex items-start gap-2 rounded-lg px-2.5 py-2 text-left"
                  style={{ cursor: 'pointer', background: T.surface, border: `1px solid ${T.border}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = alpha(m.color, 60))}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.border)}
                >
                  <m.icon size={14} style={{ color: m.color, marginTop: 2, flexShrink: 0 }} />
                  <span className="flex flex-col min-w-0">
                    <span className="text-xs font-medium" style={{ color: T.text }}>
                      {m.label}
                    </span>
                    <span className="text-[11px]" style={{ color: T.text3, lineHeight: 1.35 }}>
                      {m.what}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2" style={{ position: 'sticky', top: 0 }}>
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-medium" style={{ color: T.text2 }}>
            How it flows
          </span>
          {stale && (
            <span className="text-[11px] rounded px-1.5 py-0.5" style={{ background: T.amberTint, color: T.amber }} title="The steps have a problem, so this shows the last version that loaded">
              last version that loaded
            </span>
          )}
        </div>
        {diagram ? (
          <div style={{ opacity: stale ? 0.55 : 1, transition: 'opacity 150ms' }}>
            <InlineDiagram code={diagram} />
          </div>
        ) : (
          <span className="text-xs py-6 text-center rounded-xl" style={{ color: T.text3, border: `1px dashed ${T.border}` }}>
            The flowchart appears once the steps load.
          </span>
        )}
      </div>
    </div>
  )
}
