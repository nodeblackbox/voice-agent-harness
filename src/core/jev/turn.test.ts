import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { parsePlaybook, type Playbook } from '../playbooks/schema'
import { readAnswers, turnQuestions, turnState, ROOT_QUESTION } from './turn'

const pb = (id: string, triggers: string): Playbook => {
  const r = parsePlaybook(id, `---\ntitle: ${id}\ngoal: x.\ntriggers:\n${triggers}\n---\nDo.\n`)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.playbook
}
const m = (role: ChatMessage['role'], text: string): ChatMessage => ({ id: text, turnId: 't', sessionId: 's', role, text, createdAt: 1 })

describe('Jev turn questions', () => {
  const push = pb('push', '  ask:\n    question: "Is `latest` asking to push now?"\n    yes: "Asks to push"\n    no: "Anything else"')

  it('builds one request: the root question and each playbook question under its own name', () => {
    expect(turnQuestions({ root: true, asks: [push] })).toEqual({
      intent: ROOT_QUESTION,
      pb_push: { type: 'noul', instructions: 'Is `latest` asking to push now?', criteria: { true: 'Asks to push', false: 'Anything else' } }
    })
    expect(Object.keys(ROOT_QUESTION.criteria)).toEqual(['task', 'question', 'chat', 'idea', 'feedback'])
  })

  it('gives Jev the message plus the last four chat messages, trimmed and without shell commands', () => {
    const earlier = [m('user', 'one'), m('tool', 'tool output'), m('assistant', 'two'), m('user', 'three'), m('assistant', 'four'), m('user', 'five')]
    expect(turnState('run curl -X POST http://x', earlier)).toEqual({ latest: 'run [a command]', earlier: ['assistant: two', 'user: three', 'assistant: four', 'user: five'] })
    expect(turnState('hi', [])).toEqual({ latest: 'hi' })
  })

  it('reads the answers: unsure below the floor, each yes probability per playbook', () => {
    const plan = { root: true, asks: [push] }
    const answers = {
      intent: { type: 'choice' as const, choice: 'idea', confidence: 0.42, probabilities: { idea: 0.42, task: 0.58 } },
      pb_push: { type: 'noul' as const, noul: 0.9 }
    }
    expect(readAnswers(answers, plan, 0.5)).toEqual({ intent: 'unsure', intentP: 0.42, asks: { push: 0.9 } })
    expect(readAnswers(answers, plan, 0.4).intent).toBe('idea')
    expect(readAnswers(answers, { root: false, asks: [] }, 0.5)).toEqual({ intent: null, intentP: null, asks: {} })
  })
})
