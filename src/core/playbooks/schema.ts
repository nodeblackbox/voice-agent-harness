// A playbook file: a YAML header between `---` lines, then a plain-language body that is the instruction
// the assistant gets when the playbook fires. One `parsePlaybook` is used by the loader, the tests and
// (later) the editor and voice authoring, so every path reports the same errors with the same line numbers.

import { LineCounter, parseDocument, isMap, isScalar, type Node as YamlNode } from 'yaml'
import { z } from 'zod'
import { compile, ExprError, type Compiled } from './expr'

export const PLAYBOOK_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/

/** Events this version can react to. Others are accepted with a warning, since they never fire yet. */
export const KNOWN_EVENTS = ['turn.user'] as const

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
  tuning: 'the Playbooks tuning values, e.g. tuning.longMessageChars'
}

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
  kind: z.literal('playbook', { error: 'kind must be "playbook" (runbooks come in a later version)' }).default('playbook'),
  title: z.string().trim().min(1, 'title is empty').max(80, 'title is longer than 80 characters'),
  goal: z.string().trim().min(1, 'goal is empty').max(300, 'goal is longer than 300 characters'),
  enabled: z.boolean().default(true),
  priority: z.enum(PRIORITIES).default('normal'),
  triggers: z
    .strictObject({
      events: z.array(z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]*)*$/, 'an event is a dotted name like turn.user, or a prefix ending in a dot like cc.')).min(1, 'list at least one event').default(['turn.user']),
      said: z.array(z.string().trim().min(1)).default([]),
      when: z.string().trim().min(1).nullable().default(null)
    })
    .default({ events: ['turn.user'], said: [], when: null }),
  gates: z
    .strictObject({
      cooldownS: z.number().min(0, 'cooldownS cannot be negative').default(0),
      maxPerSession: z.number().int().min(1, 'maxPerSession is at least 1').nullable().default(null)
    })
    .default({ cooldownS: 0, maxPerSession: null }),
  mode: z.literal('inject', { error: 'mode must be "inject" (canned and hybrid come in a later version)' }).default('inject'),
  tags: z.array(z.string()).default([])
})

export type PlaybookHeader = z.infer<typeof Header>

export interface Playbook extends PlaybookHeader {
  id: string
  /** The instruction given to the assistant when it fires. */
  body: string
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

  let condition: Compiled | null = null
  if (header.triggers.when) {
    try {
      condition = compile(header.triggers.when)
      for (const name of condition.names) {
        const head = name.split('.')[0]!
        if (!(head in CONTEXT_FIELDS)) warnings.push({ line: nodeLine(['triggers', 'when']), message: `"${name}" is not a field this event has, so it is always empty (fields: ${Object.keys(CONTEXT_FIELDS).join(', ')})` })
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
  if (!body) errors.push({ line: 0, message: 'the instruction under the header is empty' })
  if (!header.triggers.when && !phrases.length) warnings.push({ line: nodeLine(['triggers']), message: 'no when or said condition: this fires on every matching event' })

  if (errors.length) return { ok: false, errors, warnings }
  return { ok: true, warnings, playbook: { ...header, id, body, phrases, condition, source: text } }
}
