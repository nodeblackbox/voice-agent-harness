// A playbook file: a YAML header between `---` lines, then a plain-language body that is the instruction
// the assistant gets when the playbook fires. One `parsePlaybook` is used by the loader, the tests and
// (later) the editor and voice authoring, so every path reports the same errors with the same line numbers.

import { LineCounter, parseDocument, isMap, isScalar, type Node as YamlNode } from 'yaml'
import { z } from 'zod'
import { compile, ExprError, type Compiled } from './expr'
import { Budget, checkSteps, type CheckedSteps } from '../runbooks/steps'

export const PLAYBOOK_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Events this version can react to. Others are accepted with a warning, since they never fire yet. */
export const KNOWN_EVENTS = ['turn.user', 'cc.finished', 'cc.needs_input', 'clock.tick'] as const
export type KnownEvent = (typeof KNOWN_EVENTS)[number]

/** What the events other than a user message carry. Only runbooks react to them: there is no reply to shape. */
export const EVENT_FIELDS: Record<Exclude<KnownEvent, 'turn.user'>, Record<string, string>> = {
  'cc.finished': {
    session: "the Claude Code session's name",
    sessionId: 'its id (a claude step can message it with session: "{{sessionId}}")',
    summary: 'what it said it did',
    folder: 'the folder it works in',
    mode: 'its mode: plan, ask, auto or bypass',
    changedFiles: 'files changed and not yet committed there, by git status (empty when the folder is not a git repository)',
    changes: 'the same in words: "1 changed file", "3 changed files"'
  },
  'cc.needs_input': {
    session: "the Claude Code session's name",
    sessionId: 'its id',
    kind: 'what it needs: question, permission or plan',
    summary: 'what it is asking'
  },
  'clock.tick': {
    time: 'the local time as "HH:MM", once a minute',
    hour: 'the hour, 0 to 23',
    minute: 'the minute, 0 to 59 (minute % 10 == 0 is every ten minutes)',
    weekday: 'monday, tuesday, ... sunday',
    sessionsWaiting: 'Claude Code sessions waiting on the user (a question, a permission or a plan)',
    waitingNames: 'their names, joined with "and"',
    oldestWaitMinutes: 'how long the longest of them has been waiting, in minutes',
    sessionsWorking: 'Claude Code sessions working right now'
  }
}

/** Fields a `when:` expression can read on a `turn.user` event. */
export const CONTEXT_FIELDS: Record<string, string> = {
  text: 'what the user said or typed',
  chars: 'its length in characters',
  words: 'its length in words',
  via: '"voice" or "typed"',
  project: 'the active project name, empty when none',
  projectId: 'the active project id, empty when none',
  turnIndex: 'how many user messages came before this one in the conversation',
  fromSplit: 'true when the message is a piece split out of a longer one',
  tuning: 'the Playbooks tuning values, e.g. tuning.longMessageChars',
  intent: 'what kind of message Jev read it as: task, question, chat, idea, feedback, or unsure (empty without Jev)',
  intentP: "Jev's confidence in that reading, 0 to 1"
}

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
        .default(null)
    })
    .default({ events: ['turn.user'], said: [], when: null, ask: null }),
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
  if (!header.triggers.when && !phrases.length) {
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
