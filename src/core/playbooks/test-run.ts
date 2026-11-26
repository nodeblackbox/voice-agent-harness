// "Would this have fired?": replay recent user messages against a playbook draft. On/off and gates are not
// applied, so the answer is about the trigger itself. A playbook that needs Jev gets Jev's real answers when a
// key is set (the newest JEV_TEST_LIMIT messages, a few at a time, each read on its own without the
// conversation around it); without a key its rows say why they cannot match.

import type { ChatMessage, PlaybookTestRow } from '@shared/types'
import { matchPlaybook, planJev, type EngineLimits, type JevFacts, type TurnFacts } from './engine'
import { parsePlaybook, usesJev, type ParseIssue } from './schema'
import { readAnswers, turnQuestions, turnState } from '../jev/turn'
import type { JevClient } from '../jev/client'

export const JEV_TEST_LIMIT = 20
const PARALLEL = 4

export interface TestRunResult {
  errors: ParseIssue[]
  rows: PlaybookTestRow[]
  /** How Jev took part: asked (with the cost), or why it was not. */
  jevNote?: string
}

export async function testPlaybook(
  id: string,
  text: string,
  messages: ChatMessage[],
  tuning: EngineLimits['tuning'],
  jev?: { client: JevClient; timeoutMs: number; intentMin: number }
): Promise<TestRunResult> {
  const r = parsePlaybook(id, text)
  if (!r.ok) return { errors: r.errors, rows: [] }
  const p = { ...r.playbook, enabled: true }
  const users = messages.filter((m) => m.role === 'user' && m.text.trim())
  const facts = (m: ChatMessage): TurnFacts => ({ text: m.text, via: m.via === 'voice' ? 'voice' : 'typed', project: '', projectId: '', turnIndex: 0, fromSplit: false })

  if (!usesJev(p)) return { errors: [], rows: users.map((m) => ({ text: m.text, createdAt: m.createdAt, via: m.via, why: matchPlaybook(p, facts(m), tuning) })) }

  if (!jev?.client.configured()) {
    return { errors: [], rows: users.map((m) => ({ text: m.text, createdAt: m.createdAt, via: m.via, why: null })), jevNote: 'This playbook needs Jev, and there is no TypeSafe key (Settings > Providers), so nothing can match.' }
  }

  const asked = users.slice(0, JEV_TEST_LIMIT)
  const answers = new Map<ChatMessage, JevFacts | null>()
  let usd = 0
  let failed = 0
  for (let i = 0; i < asked.length; i += PARALLEL) {
    await Promise.all(
      asked.slice(i, i + PARALLEL).map(async (m) => {
        const plan = planJev([p], facts(m), tuning)
        if (!plan.root && !plan.asks.length) return answers.set(m, null)
        try {
          const res = await jev.client.ask(turnState(m.text, []), turnQuestions(plan), { timeoutMs: Math.max(jev.timeoutMs, 3000) })
          usd += res.usd
          answers.set(m, readAnswers(res.answers, plan, jev.intentMin))
        } catch {
          failed++
          answers.set(m, null)
        }
      })
    )
  }
  const rows = asked.map((m) => ({ text: m.text, createdAt: m.createdAt, via: m.via, why: matchPlaybook(p, facts(m), tuning, answers.get(m) ?? undefined) }))
  const cost = usd > 0 ? `, about $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}` : ''
  const jevNote = `Jev read your last ${asked.length} messages one by one, without the conversation around them${cost}.${failed ? ` ${failed} got no answer.` : ''}`
  return { errors: [], rows, jevNote }
}
