// The steps of a runbook: an ordered list that runs in the background after a trigger fires, sharing one
// scratchpad. Each step does one thing; by default the next one in the list follows, and `next` sends a
// branch elsewhere ("end" stops). Parsed and checked here, run by runner.ts.

import { z } from 'zod'
import { compile, ExprError, type Compiled } from '../playbooks/expr'

/** Tools a `tool` step may call: they look things up, remember or draw, and cannot change the user's files or start work. */
export const RUNBOOK_TOOLS = ['remember', 'update_memory', 'recall', 'web_search', 'read_page', 'current_time', 'diagram_create'] as const

const ID = /^[a-z][a-z0-9_-]{0,30}$/
const name = z.string().regex(ID, 'a step id is lowercase letters, digits, - or _, starting with a letter')
const target = z.string().min(1)

const Model = z.strictObject({
  id: name,
  do: z.literal('model'),
  prompt: z.string().trim().min(5, 'prompt is empty'),
  save: name,
  /** Split the answer into a list (one item per line, bullets removed); also saves <save>_count. */
  list: z.boolean().default(false),
  next: target.optional()
})

const Check = z.strictObject({
  id: name,
  do: z.literal('check'),
  if: z.string().trim().min(1),
  next: z.strictObject({ yes: target, no: target })
})

const Ask = z.strictObject({
  id: name,
  do: z.literal('ask'),
  question: z.string().trim().min(10, 'question is too short'),
  /** What `latest` is for the question: a saved value; default the user's last reply, else the message that started the run. */
  about: name.optional(),
  /** Choice options (key -> what it means). Without them it is a yes/no question. */
  options: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1)).optional(),
  min: z.number().min(0.5).max(0.99).default(0.6),
  save: name.optional(),
  next: z.record(z.string(), target)
})

const Say = z.strictObject({ id: name, do: z.literal('say'), text: z.string().trim().min(1), next: target.optional() })

const Wait = z.strictObject({
  id: name,
  do: z.literal('wait'),
  for: z.literal('reply').default('reply'),
  save: name.default('reply'),
  expireS: z.number().int().min(10).max(86_400).default(180),
  next: target.optional()
})

const Tool = z.strictObject({
  id: name,
  do: z.literal('tool'),
  tool: z.enum(RUNBOOK_TOOLS, { error: `tool must be one of ${RUNBOOK_TOOLS.join(', ')}` }),
  args: z.record(z.string(), z.unknown()).default({}),
  /** Run once per item of a saved list, with {{item}} in the args. */
  each: name.optional(),
  save: name.optional(),
  next: target.optional()
})

const Claude = z.strictObject({
  id: name,
  do: z.literal('claude'),
  /** A new session's name, spoken-friendly. */
  name: z.string().trim().min(1).max(40).optional(),
  /** Message this existing session (its name or id, e.g. "{{sessionId}}" from cc.finished) instead of starting one. */
  session: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(5),
  /** Where it works: "app" = this app's own source folder, "sandbox" = a fresh folder of its own. */
  folder: z.enum(['app', 'sandbox']).default('sandbox'),
  next: target.optional()
})

export const Step = z.discriminatedUnion('do', [Model, Check, Ask, Say, Wait, Tool, Claude], { error: 'do must be one of model, check, ask, say, wait, tool, claude' })
export type Step = z.infer<typeof Step>
export type StepKind = Step['do']

export const Budget = z.strictObject({
  maxSteps: z.number().int().min(1).max(60).default(15),
  /** Working time, not counting waits for the user. */
  maxSeconds: z.number().int().min(5).max(900).default(120)
})
export type Budget = z.infer<typeof Budget>

export interface CheckedSteps {
  steps: Step[]
  /** Compiled `check` conditions by step id. */
  conditions: Record<string, Compiled>
}

export interface StepIssue {
  path: Array<string | number>
  message: string
}

/** Validate the raw `steps` list: each step's shape, unique ids, branch targets that exist, conditions that compile. */
export function checkSteps(raw: unknown): { ok: true; value: CheckedSteps; warnings: StepIssue[] } | { ok: false; errors: StepIssue[] } {
  const errors: StepIssue[] = []
  const warnings: StepIssue[] = []
  if (!Array.isArray(raw) || !raw.length) return { ok: false, errors: [{ path: ['steps'], message: 'a runbook needs a list of steps' }] }
  if (raw.length > 30) errors.push({ path: ['steps'], message: 'at most 30 steps' })
  const steps: Step[] = []
  raw.forEach((s, i) => {
    const r = Step.safeParse(s)
    if (!r.success) {
      for (const issue of r.error.issues) {
        const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))
        if (issue.code === 'unrecognized_keys') for (const k of issue.keys) errors.push({ path: ['steps', i, ...path, k], message: `unknown field "${k}" in step ${i + 1}` })
        else {
          // "do must be one of..." already names its field
          const where = path.length && !issue.message.startsWith(String(path[path.length - 1])) ? ` ${path.join('.')}` : ''
          errors.push({ path: ['steps', i, ...path], message: `step ${i + 1}${where}: ${issue.message}` })
        }
      }
    } else steps.push(r.data)
  })
  if (errors.length) return { ok: false, errors }

  const ids = new Set<string>()
  steps.forEach((s, i) => {
    if (s.id === 'end') errors.push({ path: ['steps', i, 'id'], message: '"end" is reserved for stopping' })
    if (ids.has(s.id)) errors.push({ path: ['steps', i, 'id'], message: `two steps are called "${s.id}"` })
    ids.add(s.id)
  })
  const known = (t: string): boolean => t === 'end' || ids.has(t)
  const conditions: Record<string, Compiled> = {}
  const saved = new Set<string>(['text', 'recent', 'reply'])
  steps.forEach((s, i) => {
    const targets = typeof s.next === 'string' ? [s.next] : s.next ? Object.values(s.next) : []
    for (const t of targets) if (!known(t)) errors.push({ path: ['steps', i, 'next'], message: `step "${s.id}" goes to "${t}", which is not a step (or "end")` })
    if (s.do === 'check') {
      try {
        conditions[s.id] = compile(s.if)
      } catch (e) {
        errors.push({ path: ['steps', i, 'if'], message: `step "${s.id}": ${(e as Error).message}${e instanceof ExprError ? ` at column ${e.column}` : ''}` })
      }
    }
    if (s.do === 'ask') {
      const keys = s.options ? [...Object.keys(s.options), 'unsure'] : ['yes', 'no', 'unsure']
      for (const k of Object.keys(s.next)) if (!keys.includes(k)) errors.push({ path: ['steps', i, 'next', k], message: `step "${s.id}": "${k}" is not an answer to this question (answers: ${keys.join(', ')})` })
      if (!/`latest`/.test(s.question)) warnings.push({ path: ['steps', i, 'question'], message: `step "${s.id}": refer to what is asked about as \`latest\`` })
      if (s.options && Object.keys(s.options).length < 2) errors.push({ path: ['steps', i, 'options'], message: `step "${s.id}": a choice needs at least two options` })
    }
    if (s.do === 'tool' && s.each && !saved.has(s.each)) warnings.push({ path: ['steps', i, 'each'], message: `step "${s.id}": "${s.each}" is not saved by an earlier step` })
    if ('save' in s && s.save) {
      saved.add(s.save)
      if (s.do === 'model' && s.list) saved.add(`${s.save}_count`)
    }
  })
  steps.forEach((s, i) => {
    if (s.do === 'claude' && !s.name === !s.session) errors.push({ path: ['steps', i], message: `step "${s.id}": give a name (start a new session) or a session (message one that exists), not both` })
  })
  // a claude step only makes sense after the user was asked: the runner refuses it otherwise
  const firstWait = steps.findIndex((s) => s.do === 'wait')
  steps.forEach((s, i) => {
    if (s.do === 'claude' && (firstWait < 0 || i < firstWait)) errors.push({ path: ['steps', i], message: `step "${s.id}": a claude step must come after a wait step, so the user says yes first` })
  })
  if (errors.length) return { ok: false, errors }
  return { ok: true, value: { steps, conditions }, warnings }
}

/**
 * The assistant's tools a runbook's steps do the work of: on the turns where a run starts or gets its reply, the
 * reply is not given these, so it cannot do the job a second time (save the same tasks, start the same session).
 */
export function toolsDoneBy(steps: Step[]): string[] {
  const names = new Set<string>()
  for (const s of steps) {
    if (s.do === 'tool' && s.tool !== 'recall' && s.tool !== 'current_time' && s.tool !== 'web_search' && s.tool !== 'read_page') names.add(s.tool)
    // saving to memory has two doors; the reply was seen reaching for the other one
    if (s.do === 'tool' && (s.tool === 'remember' || s.tool === 'update_memory')) for (const n of ['remember', 'update_memory']) names.add(n)
    // seen live: told a job would push, the reply sent the user's "no thanks" to the session with claude_answer
    if (s.do === 'claude') for (const n of ['claude_start', 'claude_send', 'claude_answer']) names.add(n)
  }
  return [...names]
}

/** The flow as Mermaid, for the Playbooks view: one box per step, labelled by what it does. */
export function runbookMermaid(steps: Step[]): string {
  const label = (s: Step): string => {
    const clip = (t: string, n = 34): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
    const text =
      s.do === 'model'
        ? `model → ${s.save}${s.list ? ' (list)' : ''}`
        : s.do === 'check'
          ? `check ${clip(s.if)}`
          : s.do === 'ask'
            ? `ask: ${clip(s.question)}`
            : s.do === 'say'
              ? `say: ${clip(s.text)}`
              : s.do === 'wait'
                ? `wait for reply → ${s.save}`
                : s.do === 'tool'
                  ? `${s.tool}${s.each ? ` for each ${s.each}` : ''}`
                  : s.session
                    ? `tell Claude Code ${s.session}`
                    : `Claude Code: ${s.name}`
    // inside a quoted Mermaid label only these need escaping: a double quote ends it, < and > read as HTML
    return `${s.id}: ${text}`.replace(/"/g, "'").replace(/</g, '#lt;').replace(/>/g, '#gt;')
  }
  const shape = (s: Step): string => (s.do === 'check' || s.do === 'ask' ? `{"${label(s)}"}` : s.do === 'wait' ? `(["${label(s)}"])` : `["${label(s)}"]`)
  const lines = ['flowchart TD', '  start((start))']
  steps.forEach((s) => lines.push(`  ${s.id}${shape(s)}`))
  lines.push('  end_((end))')
  const ref = (t: string): string => (t === 'end' ? 'end_' : t)
  lines.push(`  start --> ${steps[0]!.id}`)
  steps.forEach((s, i) => {
    const after = steps[i + 1]?.id ?? 'end'
    if (typeof s.next === 'object' && s.next) {
      for (const [k, t] of Object.entries(s.next)) lines.push(`  ${s.id} -->|${k}| ${ref(t)}`)
      if (s.do === 'ask') {
        // an answer with no branch of its own goes on to the next step; unsure without one stops
        for (const k of s.options ? Object.keys(s.options) : ['yes', 'no']) if (!(k in s.next)) lines.push(`  ${s.id} -->|${k}| ${ref(after)}`)
        if (!('unsure' in s.next)) lines.push(`  ${s.id} -->|unsure| end_`)
      }
    } else lines.push(`  ${s.id} --> ${ref(typeof s.next === 'string' ? s.next : after)}`)
  })
  return lines.join('\n')
}
