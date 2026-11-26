// A playbook file: a YAML header between `---` lines, then a plain-language body that is the instruction
// the assistant gets when the playbook fires. One `parsePlaybook` is used by the loader, the tests and
// (later) the editor and voice authoring, so every path reports the same errors with the same line numbers.

import { LineCounter, parseDocument, isMap, isScalar, type Node as YamlNode } from 'yaml'
import { z } from 'zod'
import { compile, ExprError, type Compiled } from './expr'
import { Budget, checkSteps, type CheckedSteps } from '../runbooks/steps'
import { DAYS, TIME } from '@shared/schedule'

export const PLAYBOOK_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/

import { CONTEXT_FIELDS, EVENT_FIELDS, KNOWN_EVENTS, type KnownEvent } from '@shared/playbookFile'
export { CONTEXT_FIELDS, EVENT_FIELDS, KNOWN_EVENTS, type KnownEvent }

/** Fields that only have a value when Jev answered this turn. */
export const JEV_FIELDS = new Set(['intent', 'intentP'])

export const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const
export type Priority = (typeof PRIORITIES)[number]

const STOPWORDS = new Set(
  'a an the and or but so to of in on at for with by from is are was were be been am i you he she it we they me my your our their this that these those do does did can could will would should just please hey ok okay um uh like'.split(' ')
)

/** The words of a phrase or utterance that carry meaning: lowercase, no punctuation, no stopwords. */
export function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w && !STOPWORDS.has(w))
}

const Header = z.strictObject({
  kind: z.enum(['playbook', 'runbook'], { error: 'kind must be "playbook" or "runbook"' }).default('playbook'),
  title: z.string().trim().min(1, 'title is empty').max(80, 'title is longer than 80 characters'),
  goal: z.string().trim().min(1, 'goal is empty').max(300, 'goal is longer than 300 characters'),
  enabled: z.boolean().default(true),
  priority: z.enum(PRIORITIES).default('normal'),
  triggers: z
    .strictObject({
      events: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]*)*$/, 'an event is a dotted name like turn.user, or a prefix ending in a dot like cc.')).min(1, 'list at least one event').default(['turn.user']),
      said: z.array(z.string().trim().min(1)).default([]),
      when: z.string().trim().min(1).nullable().default(null),
      ask: z
        .strictObject({
          question: z.string().trim().min(10, 'ask.question is too short to be a question').max(400, 'ask.question is longer than 400 characters'),
          yes: z.string().trim().min(1).optional(),
          no: z.string().trim().min(1).optional(),
          min: z.number().min(0.5, 'ask.min is at least 0.5').max(0.99, 'ask.min is at most 0.99').default(0.7)
        })
        .nullable()
        .default(null),
      /** With the `schedule` event: when it runs by the clock. */
      schedule: z
        .strictObject({
          at: z.array(z.string().trim().regex(TIME, 'a time is "HH:MM", 24-hour, like "09:00" or "17:30"')).default([]),
          every: z.number().int('every is a whole number of minutes').min(1, 'every is at least 1 minute').max(1440, 'every is at most 1440 minutes (a day)').nullable().default(null),
          days: z.array(z.enum(DAYS, { error: 'a day is mon, tue, wed, thu, fri, sat or sun' })).default([]),
          from: z.string().trim().regex(TIME, 'from is "HH:MM", like "09:00"').nullable().default(null),
          until: z.string().trim().regex(TIME, 'until is "HH:MM", like "18:00"').nullable().default(null)
        })
        .nullable()
        .default(null)
    })
    .default({ events: ['turn.user'], said: [], when: null, ask: null, schedule: null }),
  gates: z
    .strictObject({
      cooldownS: z.number().min(0, 'cooldownS cannot be negative').default(0),
      maxPerSession: z.number().int().min(1, 'maxPerSession is at least 1').nullable().default(null)
    })
    .default({ cooldownS: 0, maxPerSession: null }),
  mode: z.literal('inject', { error: 'mode must be "inject" (canned and hybrid come in a later version)' }).default('inject'),
  tags: z.array(z.string()).default([]),
  /** Runbooks: a few words the reply says when it starts ("on it, pulling the tasks out"); none = it starts silently. */
  ack: z.string().trim().min(1).max(200).nullable().default(null),
  /** Runbooks: the caps on one run. */
  budget: Budget.default({ maxSteps: 15, maxSeconds: 120 }),
  /** Runbooks: the steps, checked by checkSteps. */
  steps: z.array(z.unknown()).default([])
})

export type PlaybookHeader = z.infer<typeof Header>

/** Whether a playbook needs Jev's answer: it asks a question, or its condition reads the intent. */
export function usesJev(p: Pick<Playbook, 'triggers' | 'condition'>): boolean {
  return !!p.triggers.ask || !!p.condition?.names.some((n) => JEV_FIELDS.has(n.split('.')[0]!))
}

export interface Playbook extends Omit<PlaybookHeader, 'steps'> {
  id: string
  /** Playbook: the instruction given to the assistant when it fires. Runbook: notes on what it is for (not sent anywhere). */
  body: string
  /** Runbooks only: the checked steps and their compiled conditions. */
  runbook: CheckedSteps | null
  /** Phrases as content-word sets; a phrase matches when every one of its words was said. */
  phrases: Array<{ text: string; words: string[] }>
  condition: Compiled | null
  /** The file text as loaded, so the file stays the one source of truth. */
  source: string
}

export interface ParseIssue {
  /** 1-based line in the file; 0 when it applies to the whole file. */
  line: number
  message: string
}

export type ParseResult = { ok: true; playbook: Playbook; warnings: ParseIssue[] } | { ok: false; errors: ParseIssue[]; warnings: ParseIssue[] }

/** Split `---\nheader\n---\nbody`. `headerLine` is the file line the header text starts on. */
function splitFile(text: string): { header: string; body: string; headerLine: number } | null {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(src)
  if (!m) return null
  return { header: m[1]!, body: m[2]!, headerLine: 2 }
}

export function parsePlaybook(id: string, text: string): ParseResult {
  const errors: ParseIssue[] = []
  const warnings: ParseIssue[] = []
  if (!PLAYBOOK_ID.test(id)) errors.push({ line: 0, message: `the file name "${id}" must be lowercase letters, digits, - or _ (up to 41 characters)` })

  const parts = splitFile(text)
  if (!parts) return { ok: false, errors: [...errors, { line: 1, message: 'the file must start with a header between two --- lines' }], warnings }

  const counter = new LineCounter()
  const doc = parseDocument(parts.header, { lineCounter: counter, prettyErrors: false })
  const lineOf = (offset: number | undefined): number => (offset === undefined ? 0 : counter.linePos(offset).line + parts.headerLine - 1)
  for (const e of doc.errors) errors.push({ line: lineOf(e.pos[0]), message: `YAML: ${e.message.split('\n')[0]}` })
  if (errors.length) return { ok: false, errors, warnings }

  const nodeLine = (path: Array<string | number>): number => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true) as YamlNode | undefined
      if (node && (isScalar(node) || isMap(node) || 'range' in node) && node.range) return lineOf(node.range[0])
    }
    return parts.headerLine
  }

  const raw = doc.toJS() ?? {}
  const parsed = Header.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p))
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) errors.push({ line: nodeLine([...path, key]), message: `unknown field "${[...path, key].join('.')}"` })
      } else {
        const where = path.length ? `${path.join('.')}: ` : ''
        errors.push({ line: nodeLine(path), message: `${where}${issue.message}` })
      }
    }
    return { ok: false, errors, warnings }
  }
  const header = parsed.data

  // the known events this playbook listens to (a prefix such as cc. covers several)
  const events = new Set<KnownEvent>()
  for (const ev of header.triggers.events) for (const k of KNOWN_EVENTS) if (k === ev || (ev.endsWith('.') && k.startsWith(ev))) events.add(k)
  const otherEvents = [...events].filter((e) => e !== 'turn.user')
  if (otherEvents.length && header.kind === 'playbook') errors.push({ line: nodeLine(['triggers', 'events']), message: `a playbook shapes a reply, so it only reacts to turn.user; to react to ${otherEvents.join(' or ')}, make it kind: runbook` })
  if (otherEvents.length && (header.triggers.said.length || header.triggers.ask)) errors.push({ line: nodeLine(['triggers', header.triggers.said.length ? 'said' : 'ask']), message: `said and ask read what the user said, so they only work with turn.user, not ${otherEvents.join(' or ')}` })
  const sched = header.triggers.schedule
  if (events.has('schedule') && !sched) errors.push({ line: nodeLine(['triggers', 'events']), message: 'the schedule event needs triggers.schedule: when it runs (at: ["09:00"], or every: 30 minutes)' })
  if (sched && !events.has('schedule')) errors.push({ line: nodeLine(['triggers', 'schedule']), message: 'triggers.schedule only applies with the schedule event: add schedule to triggers.events' })
  if (sched && !sched.at.length && !sched.every) errors.push({ line: nodeLine(['triggers', 'schedule']), message: 'triggers.schedule: give at (times of day) or every (minutes), or both' })
  if (sched && !sched.every && (sched.from || sched.until)) warnings.push({ line: nodeLine(['triggers', 'schedule']), message: 'triggers.schedule: from and until only bound every; at times run whenever they are' })
  if (sched?.from && sched.until && sched.from.padStart(5, '0') >= sched.until.padStart(5, '0')) errors.push({ line: nodeLine(['triggers', 'schedule', 'until']), message: 'triggers.schedule: until must be later than from' })
  const fields: Record<string, string> = { tuning: CONTEXT_FIELDS.tuning! }
  if (events.has('turn.user') || !events.size) Object.assign(fields, CONTEXT_FIELDS)
  for (const e of otherEvents) Object.assign(fields, EVENT_FIELDS[e as Exclude<KnownEvent, 'turn.user'>])

  let condition: Compiled | null = null
  if (header.triggers.when) {
    try {
      condition = compile(header.triggers.when)
      for (const name of condition.names) {
        const head = name.split('.')[0]!
        if (!(head in fields)) warnings.push({ line: nodeLine(['triggers', 'when']), message: `"${name}" is not a field this event has, so it is always empty (fields: ${Object.keys(fields).join(', ')})` })
      }
    } catch (e) {
      const col = e instanceof ExprError ? ` at column ${e.column}` : ''
      errors.push({ line: nodeLine(['triggers', 'when']), message: `triggers.when: ${(e as Error).message}${col}` })
    }
  }

  const phrases = header.triggers.said.map((p, i) => {
    const words = contentWords(p)
    if (words.length < 2) errors.push({ line: nodeLine(['triggers', 'said', i]), message: `triggers.said: "${p}" needs at least two meaningful words, or it fires by accident` })
    return { text: p, words }
  })

  header.triggers.events.forEach((ev, i) => {
    const known = (KNOWN_EVENTS as readonly string[]).some((k) => k === ev || (ev.endsWith('.') && k.startsWith(ev)))
    if (!known) warnings.push({ line: nodeLine(['triggers', 'events', i]), message: `"${ev}" does not fire in this version (only ${KNOWN_EVENTS.join(', ')})` })
  })

  const body = parts.body.trim()
  let runbook: CheckedSteps | null = null
  if (header.kind === 'runbook') {
    const r = checkSteps(header.steps)
    if (!r.ok) for (const e of r.errors) errors.push({ line: nodeLine(e.path), message: e.message })
    else {
      runbook = r.value
      for (const w of r.warnings) warnings.push({ line: nodeLine(w.path), message: w.message })
    }
  } else {
    if (!body) errors.push({ line: 0, message: 'the instruction under the header is empty' })
    if (header.steps.length) errors.push({ line: nodeLine(['steps']), message: 'steps belong to a runbook: set kind: runbook' })
    if (header.ack) warnings.push({ line: nodeLine(['ack']), message: 'ack is only used by runbooks' })
  }
  const ask = header.triggers.ask
  if (ask && (ask.yes === undefined) !== (ask.no === undefined)) errors.push({ line: nodeLine(['triggers', 'ask']), message: 'triggers.ask: give both yes and no (what each answer means), or neither' })
  if (ask && !/`latest`/.test(ask.question)) warnings.push({ line: nodeLine(['triggers', 'ask', 'question']), message: 'triggers.ask: refer to the message as `latest` (in backticks), which is how Jev sees it' })
  // a message or a minute comes all the time; a schedule names its own times, and the other events are rare enough
  const frequent = events.has('turn.user') || events.has('clock.tick') || events.has('cc.idle') || !events.size
  if (!header.triggers.when && !phrases.length && frequent) {
    if (ask) warnings.push({ line: nodeLine(['triggers', 'ask']), message: 'the question is asked on every message; a when or said condition asks it less often' })
    else warnings.push({ line: nodeLine(['triggers']), message: 'no when or said condition: this fires on every matching event' })
  }

  if (errors.length) return { ok: false, errors, warnings }
  const { steps: _steps, ...rest } = header
  return { ok: true, warnings, playbook: { ...rest, id, body, phrases, condition, runbook, source: text } }
}

/**
 * Change one top-level header field and keep everything else as written: comments, order and the body.
 * Returns null when the file has no header to change.
 */
export function setHeaderField(text: string, key: string, value: unknown): string | null {
  const src = text.replace(/^﻿/, '')
  const crlf = src.includes('\r\n')
  const parts = splitFile(src)
  if (!parts) return null
  const doc = parseDocument(parts.header)
  if (doc.errors.length || !isMap(doc.contents)) return null
  doc.set(key, value)
  const header = doc.toString({ lineWidth: 0 }).replace(/\n$/, '')
  const out = `---\n${header}\n---\n${parts.body}`
  return crlf ? out.replace(/\n/g, '\r\n') : out
}
