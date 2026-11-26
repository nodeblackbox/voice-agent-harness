// The questions Jev answers about a user message, built per turn from the playbooks that need them, and
// the reading of its answers back into facts the playbook engine understands. Wording follows the rules
// measured in the Jev playground (docs/03-question-design.md there): classify, never plan; describe every
// option; no "none" option; refer to the message as `latest`.

import type { ChatMessage } from '@shared/types'
import type { Playbook } from '../playbooks/schema'
import type { JevFacts } from '../playbooks/engine'
import { safeText, type Answer, type ChoiceQ, type NoulQ, type QuestionMap } from './client'

/** The root reading of every message. "idea" is first among equals: noting an idea by mistake is cheap, building it by mistake is not. */
export const INTENTS = {
  task: 'Asks for something to be done now: find, check, write, change, build, send, run, start or stop something',
  question: 'Asks for information or an explanation and expects an answer, not an action',
  chat: 'Small talk, a greeting, thanks, a reaction, or a short answer to something the assistant just asked',
  idea: 'Thinking out loud about a possible feature, plan or approach ("maybe we could", "what if", "I was thinking"), without asking for it to be done now',
  feedback: 'Comments on how the assistant itself behaved or answered: too long, wrong, not what was wanted, or liked it'
} as const

export type Intent = keyof typeof INTENTS | 'unsure'

export const ROOT_QUESTION: ChoiceQ = { type: 'choice', instructions: 'What kind of message is `latest`?', criteria: { ...INTENTS } }

const askName = (id: string): string => `pb_${id}`

export function askQuestion(p: Playbook): NoulQ {
  const a = p.triggers.ask!
  return a.yes && a.no ? { type: 'noul', instructions: a.question, criteria: { true: a.yes, false: a.no } } : { type: 'noul', instructions: a.question }
}

export function turnQuestions(plan: { root: boolean; asks: Playbook[] }): QuestionMap {
  const q: QuestionMap = {}
  if (plan.root) q.intent = ROOT_QUESTION
  for (const p of plan.asks) q[askName(p.id)] = askQuestion(p)
  return q
}

/** What Jev reads: the message, plus the last few messages for "that thing" and "yes, do it". */
export function turnState(latest: string, earlier: ChatMessage[]): { latest: string; earlier?: string[] } {
  const prior = earlier
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .slice(-4)
    .map((m) => `${m.role}: ${safeText(m.text).replace(/\s+/g, ' ').slice(0, 300)}`)
  const text = safeText(latest)
  return prior.length ? { latest: text, earlier: prior } : { latest: text }
}

/** The answers as engine facts. Below `intentMin` the reading is "unsure", which no template treats as an instruction. */
export function readAnswers(answers: Record<string, Answer>, plan: { root: boolean; asks: Playbook[] }, intentMin: number): JevFacts {
  const facts: JevFacts = { intent: null, intentP: null, asks: {} }
  const root = answers.intent
  if (plan.root && root?.type === 'choice') {
    facts.intentP = root.confidence
    facts.intent = root.confidence >= intentMin ? root.choice : 'unsure'
  }
  for (const p of plan.asks) {
    const a = answers[askName(p.id)]
    if (a?.type === 'noul') facts.asks[p.id] = a.noul
  }
  return facts
}

/** One trace line per answer: `intent idea (0.74)`, `pb_push yes 0.91`. */
export function describeAnswers(answers: Record<string, Answer>): Array<{ name: string; answer: string; p: number }> {
  return Object.entries(answers).map(([name, a]) => (a.type === 'choice' ? { name, answer: a.choice, p: a.confidence } : { name, answer: a.noul >= 0.5 ? 'yes' : 'no', p: a.noul }))
}
