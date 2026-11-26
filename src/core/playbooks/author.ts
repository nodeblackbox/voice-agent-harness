// Writing a playbook from what the user said ("from now on, whenever I ramble, break it down"): a model drafts
// the whole file against the format, the same parser the loader uses checks it, and a draft that does not
// parse gets one automatic "fix these errors" round. Ported in spirit from the Lemon co-host's drafter, with
// the file format and the Jev question rules of this app. Nothing here touches files: the caller saves.

import { CONTEXT_FIELDS, EVENT_FIELDS, PLAYBOOK_ID, parsePlaybook, type ParseIssue } from './schema'
import { GUIDE } from './templates'
import { INTENTS } from '../jev/turn'

/** Calls the drafting model: a system prompt and a user prompt in, its text out. */
export type Generate = (system: string, prompt: string) => Promise<string>

export interface DraftInput {
  /** What the user wants, in their words, made self-contained by the assistant. */
  brief: string
  /** The playbook being changed; absent for a new one. */
  current?: { id: string; source: string }
  /** Ids already taken, so a new one gets a free name. */
  taken: string[]
  /** One or two existing files to imitate. */
  examples: string[]
  /** Whether Jev can answer (a TypeSafe key is set and it is on); without it, intent and ask are not offered. */
  jev: boolean
}

export type DraftResult =
  | { ok: true; id: string; text: string; repaired: boolean; warnings: ParseIssue[] }
  | { ok: false; errors: ParseIssue[]; text: string }

function spec(jev: boolean): string {
  const fields = Object.entries(CONTEXT_FIELDS)
    .filter(([k]) => jev || (k !== 'intent' && k !== 'intentP'))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')
  const intents = Object.entries(INTENTS)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')
  return `You write playbook and runbook files for a personal voice assistant. A playbook recognises a situation in what the user says and adds an instruction to the assistant's next reply. A runbook recognises a situation and runs steps in the background (look something up, ask the user, then save or start work). You get a brief, and sometimes the current file to change; you answer with the complete file.

${GUIDE}

Fields a when: condition can read on a user message (event turn.user):
${fields}

Other events, for runbooks only (a playbook only reacts to turn.user, and said and ask need turn.user). Their fields:
${Object.entries(EVENT_FIELDS)
  .map(([ev, f]) => `${ev}:\n${Object.entries(f).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`)
  .join('\n')}
${
  jev
    ? `
intent is one of:
${intents}
(or "unsure" when Jev is not confident). Prefer intent over word lists for "what kind of message is this".

ask: a yes/no question Jev answers about the message, for what neither a phrase nor intent can tell. Rules for it:
- Refer to the message as \`latest\` in backticks. Ask Jev to classify what the message says, never to plan or judge quality.
- One condition per question. Give yes and no descriptions whenever "yes" could be read two ways.
- Do not ask what code can compute (length, counts): put that in when:.
- Put a cheap when: or said: in front when you can, so the question is asked less often.`
    : `
Jev (intent and ask) is not available here: use when: and said: only.`
}

Rules:
- Write a playbook when the brief is about how to answer. Write a runbook only when it needs steps after the reply: finding or writing something in the background, asking the user, then saving it or starting a Claude Code session. A runbook that asks before acting has a say step, then a wait step, then an ask step.
- Fire narrowly. A playbook that fires on the wrong messages is worse than none. Prefer said: phrases of two or more words and specific conditions.
- The body is an instruction to the assistant for that one reply, in plain words, second person, three to six short sentences. It is spoken aloud, so no markdown in what it asks for unless the user wants it.
- The goal is one sentence on what it is for. The title is two to five words.
- priority: high only for something that must win over other playbooks; otherwise normal.
- Keep fields the brief does not mention as they are in the current file. Do not add fields that are not in the format.
- Answer with the complete file only: start with --- and include nothing before or after it, no code fences.`
}

/** The model sometimes wraps the file in a code fence or adds a sentence; keep only the file. */
export function extractFile(text: string): string {
  let t = text.replace(/\r\n/g, '\n').trim()
  const fence = /```[a-z]*\n([\s\S]*?)\n```/.exec(t)
  if (fence) t = fence[1]!.trim()
  const start = t.indexOf('---')
  if (start > 0) t = t.slice(start)
  return t.endsWith('\n') ? t : `${t}\n`
}

/** A free id from a title: "Push after work" -> "push-after-work", "-2" when taken. */
export function idFromTitle(title: string, taken: string[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'playbook'
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

function titleOf(text: string): string {
  return /^title:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1] ?? 'playbook'
}

export async function draftPlaybook(input: DraftInput, generate: Generate): Promise<DraftResult> {
  const system = spec(input.jev)
  const examples = input.examples.length ? `Existing playbooks, for the style:\n\n${input.examples.map((e) => e.trim()).join('\n\n=====\n\n')}\n\n` : ''
  const prompt = input.current
    ? `${examples}The current file (${input.current.id}.md):\n\n${input.current.source.trim()}\n\nChange it as the brief says and answer with the whole new file.\n\nBrief: ${input.brief}`
    : `${examples}Write a new playbook.\n\nBrief: ${input.brief}`

  const idFor = (text: string): string => input.current?.id ?? idFromTitle(titleOf(text), input.taken)
  let text = extractFile(await generate(system, prompt))
  let r = parsePlaybook(idFor(text), text)
  let repaired = false
  if (!r.ok) {
    const errors = r.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)).join('\n')
    text = extractFile(await generate(system, `${prompt}\n\nYour last answer was:\n\n${text}\n\nIt does not load. Fix these errors and answer with the whole file again:\n${errors}`))
    r = parsePlaybook(idFor(text), text)
    repaired = true
  }
  if (!r.ok) return { ok: false, errors: r.errors, text }
  const id = idFor(text)
  if (!PLAYBOOK_ID.test(id)) return { ok: false, errors: [{ line: 0, message: `"${id}" is not a usable file name` }], text }
  return { ok: true, id, text, repaired, warnings: r.warnings }
}
