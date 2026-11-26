import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { testPlaybook } from './test-run'
import { setHeaderField } from './schema'

const msg = (text: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({ id: text, turnId: 't', sessionId: 's', role, text, via: 'voice', createdAt: 1 })

describe('testPlaybook', () => {
  const file = '---\ntitle: Push\ngoal: Push.\nenabled: false\ntriggers:\n  said: ["push the changes"]\n---\nOffer to push.\n'

  it('replays user messages only, says why each matched, and ignores on/off', () => {
    const out = testPlaybook('push', file, [msg('can you push my changes'), msg('push the changes', 'assistant'), msg('hello there')], {})
    expect(out.errors).toEqual([])
    expect(out.rows.map((r) => r.why)).toEqual(['said "push the changes"', null])
  })

  it('returns the parse errors instead of rows for a broken draft', () => {
    expect(testPlaybook('push', '---\ntitle: x\n---\n', [msg('a')], {}).errors.length).toBeGreaterThan(0)
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
