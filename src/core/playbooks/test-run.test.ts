import { describe, expect, it, vi } from 'vitest'
import type { JevClient } from '../jev/client'
import type { ChatMessage } from '@shared/types'
import { testPlaybook } from './test-run'
import { setHeaderField } from './schema'

const msg = (text: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id: text, turnId: 't', sessionId: 's', role, text, via: 'voice', createdAt: 1 })

describe('testPlaybook', () => {
  const file = '---\ntitle: Push\ngoal: Push.\nenabled: false\ntriggers:\n  said: ["push the changes"]\n---\nOffer to push.\n'

  it('replays user messages only, says why each matched, and ignores on/off', async () => {
    const out = await testPlaybook('push', file, [msg('can you push my changes'), msg('push the changes', 'assistant'), msg('hello there')], {})
    expect(out.errors).toEqual([])
    expect(out.rows.map((r) => r.why)).toEqual(['said "push the changes"', null])
  })

  it('returns the parse errors instead of rows for a broken draft', async () => {
    expect((await testPlaybook('push', '---\ntitle: x\n---\n', [msg('a')], {})).errors.length).toBeGreaterThan(0)
  })

  const idea = `---\ntitle: Idea\ngoal: x.\ntriggers:\n  when: 'intent == "idea"'\n---\nShape it.\n`
  const fakeJev = (choice: string) => {
    const ask = vi.fn(async () => ({ answers: { intent: { type: 'choice' as const, choice, confidence: 0.8, probabilities: { [choice]: 0.8, chat: 0.2 } } }, inputTokens: 500, usd: 0.000021, ms: 150, model: 'jev' }))
    return { client: { configured: () => true, ask } as unknown as JevClient, timeoutMs: 500, intentMin: 0.5, ask }
  }

  it('asks Jev about each message for a playbook that reads the intent, and says what it cost', async () => {
    const jev = fakeJev('idea')
    const out = await testPlaybook('idea', idea, [msg('maybe we could add a spend tab'), msg('what time is it')], {}, jev)
    expect(jev.ask).toHaveBeenCalledTimes(2)
    expect(out.rows.map((r) => r.why)).toEqual(['when intent == "idea" (intent "idea" at 0.80)', 'when intent == "idea" (intent "idea" at 0.80)'])
    expect(out.jevNote).toMatch(/last 2 messages one by one.*\$0\.0000/)
  })

  it('says a Jev playbook cannot match without a key, and asks nothing', async () => {
    const jev = fakeJev('idea')
    const out = await testPlaybook('idea', idea, [msg('maybe')], {}, { ...jev, client: { configured: () => false } as unknown as JevClient })
    expect(out.rows[0]!.why).toBeNull()
    expect(out.jevNote).toMatch(/no TypeSafe key/)
    expect(jev.ask).not.toHaveBeenCalled()
  })
})

describe('setHeaderField', () => {
  it('changes one field, keeps comments, the body and Windows line endings', () => {
    const src = '---\r\ntitle: X # the name\r\nenabled: true\r\n---\r\nBody line.\r\n'
    expect(setHeaderField(src, 'enabled', false)).toBe('---\r\ntitle: X # the name\r\nenabled: false\r\n---\r\nBody line.\r\n')
    expect(setHeaderField('---\ntitle: X\n---\nB', 'enabled', false)).toBe('---\ntitle: X\nenabled: false\n---\nB')
    expect(setHeaderField('no header', 'enabled', true)).toBeNull()
  })
})
