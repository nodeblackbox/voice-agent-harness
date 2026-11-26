// "Is this trigger right?": take the user's recent messages, see which ones the playbook's current trigger fires
// on, and ask a judge which ones it should have fired on, given the playbook's goal. Where they disagree there is
// a miss (should have fired, did not) or a false fire (fired, should not have). The user's own marks beat the
// judge. Jev judges when it can (one yes/no per message); otherwise the model judges all of them in one call.
// This is the "the smart model teaches the cheap trigger" loop from the design: the review shows the
// disagreements, and suggestTrigger drafts a tighter trigger from them for the user to check and save.

import type { ChatMessage, PlaybookEvalResult, PlaybookEvalRow, PlaybookLabel } from '@shared/types'
import type { JevClient } from '../jev/client'
import { safeText } from '../jev/client'
import { parsePlaybook, type ParseIssue } from './schema'
import { testPlaybook } from './test-run'
import { draftPlaybook, type DraftResult, type Generate } from './author'
import type { EngineLimits } from './engine'

export const EVAL_LIMIT = 20
const PARALLEL = 4
/** Jev's yes probability at or above this is "should fire", at or below 1 - this "should not", between: unsure. */
const SURE = 0.65

export interface EvalInput {
  id: string
  text: string
  /** Newest first, as the store returns them; user messages only are used. */
  messages: ChatMessage[]
  /** The user's marks for this playbook, by message id. */
  labels: Record<string, PlaybookLabel>
  tuning: EngineLimits['tuning']
  jev?: { client: JevClient; timeoutMs: number; intentMin: number }
  /** The model, for judging when Jev is not available: a prompt in, its text out. */
  generate?: (prompt: string) => Promise<string>
  limit?: number
}

/** The question the judge answers about each message: does this playbook's situation apply? */
export function judgeQuestion(goal: string, title: string): { instructions: string; criteria: { true: string; false: string } } {
  return {
    instructions: `Is \`latest\` a message where this applies: ${goal.replace(/\.$/, '')}?`,
    criteria: { true: `It is the situation "${title}" is for`, false: 'It is some other kind of message' }
  }
}

export async function evaluatePlaybook(input: EvalInput): Promise<PlaybookEvalResult & { errors: ParseIssue[] }> {
  const parsed = parsePlaybook(input.id, input.text)
  if (!parsed.ok) return { errors: parsed.errors, rows: [], summary: { checked: 0, fires: 0, agree: 0, misses: 0, falseFires: 0, unsure: 0 } }
  const p = parsed.playbook
  const users = input.messages.filter((m) => m.role === 'user' && m.text.trim()).slice(0, input.limit ?? EVAL_LIMIT)

  // what the current trigger does on each of them (a Jev trigger asks Jev, as the Test button does)
  const replay = await testPlaybook(input.id, input.text, users, input.tuning, input.jev)
  const fires = new Map(users.map((m, i) => [m.id, replay.rows[i]?.why ?? null]))

  // what the judge thinks it should do; the user's marks are not sent to it
  const toJudge = users.filter((m) => !input.labels[m.id])
  const judged = new Map<string, { yes: boolean | null; p: number | null; by: PlaybookEvalRow['by'] }>()
  let note: string | undefined
  let usd = 0
  const q = judgeQuestion(p.goal, p.title)
  if (toJudge.length && input.jev?.client.configured()) {
    for (let i = 0; i < toJudge.length; i += PARALLEL) {
      await Promise.all(
        toJudge.slice(i, i + PARALLEL).map(async (m) => {
          try {
            const r = await input.jev!.client.ask({ latest: safeText(m.text) }, { judge: { type: 'noul', ...q } }, { timeoutMs: Math.max(input.jev!.timeoutMs, 3000) })
            usd += r.usd
            const a = r.answers.judge
            const yes = a?.type === 'noul' ? a.noul : 0.5
            judged.set(m.id, { yes: yes >= SURE ? true : yes <= 1 - SURE ? false : null, p: yes, by: 'jev' })
          } catch {
            judged.set(m.id, { yes: null, p: null, by: 'none' })
          }
        })
      )
    }
    note = `Jev judged ${toJudge.length} message${toJudge.length === 1 ? '' : 's'}, about $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}.`
  } else if (toJudge.length && input.generate) {
    const list = toJudge.map((m, i) => `${i + 1}. ${safeText(m.text).replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')
    try {
      const text = await input.generate(
        `A voice assistant has a rule called "${p.title}" for this situation: ${p.goal}\n\nFor each numbered message the user said, answer whether it is that situation. One line per message, exactly "<number>: yes", "<number>: no" or "<number>: unsure", nothing else.\n\n${list}`
      )
      for (const line of text.split(/\r?\n/)) {
        const mm = /^\s*(\d+)\s*[:.)-]\s*(yes|no|unsure)/i.exec(line)
        const msg = mm ? toJudge[Number(mm[1]) - 1] : undefined
        if (msg) judged.set(msg.id, { yes: mm![2]!.toLowerCase() === 'yes' ? true : mm![2]!.toLowerCase() === 'no' ? false : null, p: null, by: 'model' })
      }
      note = `The model judged ${toJudge.length} message${toJudge.length === 1 ? '' : 's'} (no Jev).`
    } catch (e) {
      note = `The judge failed: ${(e as Error).message}. Only your own marks count.`
    }
  } else if (toJudge.length) note = 'There is no judge (no Jev and no model), so only your own marks count.'

  const rows: PlaybookEvalRow[] = users.map((m) => {
    const label = input.labels[m.id]
    const j = label ? { yes: label === 'should', p: null, by: 'label' as const } : (judged.get(m.id) ?? { yes: null, p: null, by: 'none' as const })
    const why = fires.get(m.id) ?? null
    const fired = why !== null
    const verdict: PlaybookEvalRow['verdict'] = j.yes === null ? 'unsure' : j.yes === fired ? 'agree' : fired ? 'false_fire' : 'miss'
    return { messageId: m.id, text: m.text, createdAt: m.createdAt, via: m.via, fires: fired, why, should: j.yes, p: j.p, by: j.by, label, verdict }
  })
  const count = (v: PlaybookEvalRow['verdict']): number => rows.filter((r) => r.verdict === v).length
  return {
    errors: [],
    rows,
    summary: { checked: rows.length, fires: rows.filter((r) => r.fires).length, agree: count('agree'), misses: count('miss'), falseFires: count('false_fire'), unsure: count('unsure') },
    note: [replay.jevNote, note].filter(Boolean).join(' ') || undefined
  }
}

/**
 * A tighter trigger from a review: the drafter rewrites the triggers (and nothing else it does not have to) so the
 * misses would fire and the false fires would not. The result is a draft for the user to check and save.
 */
export async function suggestTrigger(input: { id: string; text: string; rows: PlaybookEvalRow[]; jev: boolean }, generate: Generate): Promise<DraftResult> {
  const quote = (r: PlaybookEvalRow): string => `- "${r.text.replace(/\s+/g, ' ').slice(0, 300)}"`
  const misses = input.rows.filter((r) => r.verdict === 'miss')
  const wrong = input.rows.filter((r) => r.verdict === 'false_fire')
  const right = input.rows.filter((r) => r.verdict === 'agree' && r.fires)
  const brief = [
    'Change only the triggers of this file (when, said, ask, events) so it fires on the situation its goal describes and not on other messages. Keep the title, goal, instruction or steps and everything else as they are. Prefer the simplest trigger that works.',
    misses.length ? `It should have fired on these and did not:\n${misses.map(quote).join('\n')}` : '',
    wrong.length ? `It fired on these and should not have:\n${wrong.map(quote).join('\n')}` : '',
    right.length ? `It was right to fire on these (keep them):\n${right.slice(0, 5).map(quote).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n\n')
  return draftPlaybook({ brief, current: { id: input.id, source: input.text }, taken: [input.id], examples: [], jev: input.jev }, generate)
}
