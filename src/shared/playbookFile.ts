// Reading and editing a playbook file's text from the form on the Playbooks page. The file stays the single source
// of truth: a form field rewrites just that field of the YAML header (comments and order kept), and the loader's
// parser in the main process still decides whether the result is valid. Pure functions, so the renderer can use them.

import { isMap, parseDocument } from 'yaml'

/** Tools a runbook `tool` step may call (checked again by core/runbooks/steps.ts). */
export const RUNBOOK_TOOLS = ['remember', 'update_memory', 'recall', 'web_search', 'read_page', 'current_time', 'diagram_create'] as const

/** Events this version can react to. Others are accepted with a warning, since they never fire yet. */
export const KNOWN_EVENTS = [
  'turn.user',
  'cc.started', 'cc.finished', 'cc.needs_input', 'cc.error', 'cc.idle', 'cc.context', 'cc.compacted',
  'schedule', 'clock.tick', 'app.start'
] as const
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
  'cc.started': {
    session: "the new session's name",
    sessionId: 'its id',
    task: 'the first thing it was asked to do (empty when none yet)'
  },
  'cc.error': {
    session: "the Claude Code session's name",
    sessionId: 'its id',
    error: 'what went wrong, in its words'
  },
  'cc.idle': {
    session: "the Claude Code session's name",
    sessionId: 'its id',
    idleMinutes: 'how long it has sat finished with nothing to do: 5, 10, 15, 20, 30, 45, 60, then every 30',
    summary: 'what it said it did last'
  },
  'cc.context': {
    session: "the Claude Code session's name",
    sessionId: 'its id',
    percent: 'how full its context window is now, 0 to 100 (it fires each time this passes another tenth on the way up)',
    previous: 'the percent before this turn',
    tokens: 'tokens in its context now',
    maxTokens: 'the most its context holds'
  },
  'cc.compacted': {
    session: "the Claude Code session's name",
    sessionId: 'its id',
    how: '"auto" (Claude Code did it, nearly full) or "manual" (it was asked to)',
    before: 'tokens before',
    after: 'tokens after (0 when not known)'
  },
  schedule: {
    time: 'the local time as "HH:MM", when the schedule is due',
    hour: 'the hour, 0 to 23',
    minute: 'the minute, 0 to 59',
    weekday: 'monday, tuesday, ... sunday',
    sessionsWaiting: 'Claude Code sessions waiting on the user',
    waitingNames: 'their names, joined with "and"',
    sessionsWorking: 'Claude Code sessions working right now'
  },
  'app.start': {
    time: 'the local time as "HH:MM"',
    hour: 'the hour, 0 to 23',
    weekday: 'monday, tuesday, ... sunday',
    sessions: 'Claude Code sessions in the list',
    sessionsWaiting: 'of those, how many wait on the user'
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

export type FieldPath = Array<string | number>

interface Split {
  header: string
  body: string
  crlf: boolean
}

function split(text: string): Split | null {
  const crlf = text.includes('\r\n')
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(src)
  return m ? { header: m[1]!, body: m[2]!, crlf } : null
}

function join(header: string, body: string, crlf: boolean): string {
  const out = `---\n${header.replace(/\n+$/, '')}\n---\n${body}`
  return crlf ? out.replace(/\n/g, '\r\n') : out
}

export interface ReadFile {
  /** The header as plain values, or null when it cannot be read (no header, or a YAML error). */
  header: Record<string, unknown> | null
  body: string
  /** Why the header cannot be read, in a few words. */
  problem?: string
}

export function readPlaybookFile(text: string): ReadFile {
  const parts = split(text)
  if (!parts) return { header: null, body: '', problem: 'the file has no header between two --- lines' }
  const doc = parseDocument(parts.header)
  if (doc.errors.length) return { header: null, body: parts.body, problem: `YAML: ${doc.errors[0]!.message.split('\n')[0]}` }
  const value = doc.toJS() as unknown
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) return { header: null, body: parts.body, problem: 'the header is not a list of fields' }
  return { header: (value ?? {}) as Record<string, unknown>, body: parts.body }
}

/**
 * Set one field of the header, at any depth (["triggers", "when"]); `undefined` removes it. Everything else in the
 * header is kept as written. Null when the header cannot be read (the form then asks for the File tab).
 */
export function setPlaybookField(text: string, path: FieldPath, value: unknown): string | null {
  const parts = split(text)
  if (!parts) return null
  const doc = parseDocument(parts.header)
  if (doc.errors.length || (doc.contents !== null && !isMap(doc.contents))) return null
  if (value === undefined) {
    if (doc.hasIn(path)) doc.deleteIn(path)
    // an emptied section (gates with nothing left) goes too
    for (let n = path.length - 1; n > 0; n--) {
      const parent = doc.getIn(path.slice(0, n), true)
      if (isMap(parent) && parent.items.length === 0) doc.deleteIn(path.slice(0, n))
      else break
    }
  } else doc.setIn(path, value)
  return join(doc.toString({ lineWidth: 0 }), parts.body, parts.crlf)
}

/** Replace the text under the header (a playbook's instruction, a runbook's notes). */
export function setPlaybookBody(text: string, body: string): string | null {
  const parts = split(text)
  if (!parts) return null
  return join(parts.header, body.endsWith('\n') ? body : `${body}\n`, parts.crlf)
}

/** Small typed readers for form fields: what is there, or the default the loader would use. */
export const field = {
  str: (v: unknown, d = ''): string => (typeof v === 'string' ? v : d),
  num: (v: unknown, d: number | null = null): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : d),
  bool: (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d),
  list: (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []),
  obj: (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
}

export const NEW_PLAYBOOK_TEXT = `---
kind: playbook
title: New playbook
goal: What this is for, in one sentence.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  said: ["two or more words"]
gates:
  cooldownS: 0
---
What the assistant should do in this situation, in plain words.
`

export const NEW_RUNBOOK_TEXT = `---
kind: runbook
title: New runbook
goal: What this job does in the background, in one sentence.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  said: ["two or more words"]
gates:
  cooldownS: 60
ack: "On it, in the background."
budget:
  maxSteps: 10
  maxSeconds: 90
steps:
  - id: work
    do: model
    prompt: "Do something useful with {{text}}"
    save: result
  - id: tell
    do: say
    text: "Here is what I found: {{result}}"
---
Notes on what it is for.
`
