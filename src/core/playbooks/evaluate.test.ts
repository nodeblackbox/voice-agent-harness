import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { JevClient } from '../jev/client'
import { evaluatePlaybook, suggestTrigger } from './evaluate'

const msg = (id: string, text: string): ChatMessage => ({ id, turnId: 't', sessionId: 's', role: 'user', text, via: 'voice', createdAt: 1 })

const PUSH = `---
title: Push
goal: Offer to push when the user asks to publish their work.
triggers:
  said: ["push the changes"]
---
Offer to push.
`

const messages = [msg('a', 'please push the changes now'), msg('b', 'ship it to github please'), msg('c', 'can you push the changes to the notes doc, I mean the wording'), msg('d', 'what time is it')]

/** A fake TypeSafe server: yes for the messages in `yes`, no for the rest. */
function jevSaying(yes: string[]) {
  const fetch = vi.fn(async (_u: string, init: RequestInit) => {
    const latest = JSON.parse(init.body as string).state.latest as string
    return new Response(JSON.stringify({ answers: { judge: { type: 'noul', noul: yes.some((y) => latest.includes(y)) ? 0.92 : 0.05 } }, usage: { input_tokens: 300 } }))
  })
  return { client: new JevClient({ key: () => 'k', fetch: fetch as never }), timeoutMs: 500, intentMin: 0.5, fetch }
}

describe('evaluatePlaybook', () => {
  it('finds misses and false fires by comparing the trigger with the judge', async () => {
    const jev = jevSaying(['please push', 'ship it'])
    const r = await evaluatePlaybook({ id: 'push', text: PUSH, messages, labels: {}, tuning: {}, jev })
    expect(r.rows.map((x) => [x.messageId, x.fires, x.should, x.verdict])).toEqual([
      ['a', true, true, 'agree'],
      ['b', false, true, 'miss'],
      ['c', true, false, 'false_fire'],
      ['d', false, false, 'agree']
    ])
    expect(r.summary).toEqual({ checked: 4, fires: 2, agree: 2, misses: 1, falseFires: 1, unsure: 0 })
    const body = JSON.parse((jev.fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.questions.judge.instructions).toBe('Is `latest` a message where this applies: Offer to push when the user asks to publish their work?')
    expect(r.note).toMatch(/Jev judged 4 messages/)
  })

  it('takes the user’s marks over the judge, and does not ask the judge about them', async () => {
    const jev = jevSaying(['please push', 'ship it'])
    const r = await evaluatePlaybook({ id: 'push', text: PUSH, messages, labels: { c: 'should', b: 'should_not' }, tuning: {}, jev })
    expect(r.rows.find((x) => x.messageId === 'c')).toMatchObject({ should: true, by: 'label', label: 'should', verdict: 'agree' })
    expect(r.rows.find((x) => x.messageId === 'b')).toMatchObject({ should: false, by: 'label', verdict: 'agree' })
    expect(jev.fetch).toHaveBeenCalledTimes(2)
  })

  it('lets the model judge them all in one go without Jev, and is unsure where it cannot tell', async () => {
    const generate = vi.fn(async () => '1: yes\n2: yes\n3: no\n4: unsure')
    const r = await evaluatePlaybook({ id: 'push', text: PUSH, messages, labels: {}, tuning: {}, generate })
    expect(generate).toHaveBeenCalledTimes(1)
    expect((generate.mock.calls[0] as unknown as [string])[0]).toContain('2. ship it to github please')
    expect(r.rows.map((x) => x.verdict)).toEqual(['agree', 'miss', 'false_fire', 'unsure'])
    expect(r.rows[0]!.by).toBe('model')
  })

  it('returns the parse errors for a broken file', async () => {
    expect((await evaluatePlaybook({ id: 'push', text: '---\ntitle: x\n---\n', messages, labels: {}, tuning: {} })).errors.length).toBeGreaterThan(0)
  })
})

describe('suggestTrigger', () => {
  it('asks the drafter to change only the triggers, with the misses and the false fires as examples', async () => {
    const generate = vi.fn(async () => PUSH.replace('said: ["push the changes"]', 'said: ["push the changes", "ship it to github"]'))
    const rows = (await evaluatePlaybook({ id: 'push', text: PUSH, messages, labels: {}, tuning: {}, jev: jevSaying(['please push', 'ship it']) })).rows
    const r = await suggestTrigger({ id: 'push', text: PUSH, rows, jev: false }, generate)
    expect(r).toMatchObject({ ok: true, id: 'push' })
    const prompt = (generate.mock.calls[0] as unknown as [string, string])[1]
    expect(prompt).toContain('Change only the triggers')
    expect(prompt).toContain('should have fired on these and did not:\n- "ship it to github please"')
    expect(prompt).toContain('fired on these and should not have:\n- "can you push the changes to the notes doc')
    expect(prompt).toContain('right to fire on these (keep them):\n- "please push the changes now"')
  })
})
