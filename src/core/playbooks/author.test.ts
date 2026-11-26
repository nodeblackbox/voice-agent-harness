import { describe, expect, it, vi } from 'vitest'
import { draftPlaybook, extractFile, idFromTitle } from './author'

const GOOD = `---
kind: playbook
title: Push after work
goal: Offer to push when the user asks about pushing.
triggers:
  said: ["push the changes"]
---
Offer to push the changes and say which branch.
`

describe('draftPlaybook', () => {
  it('writes a new playbook with a free name from its title, and shows the model the format', async () => {
    const generate = vi.fn(async () => GOOD)
    const r = await draftPlaybook({ brief: 'when I say push the changes, offer to push', taken: ['push-after-work'], examples: ['---\ntitle: Example\n---\nx'], jev: false }, generate)
    expect(r).toMatchObject({ ok: true, id: 'push-after-work-2', repaired: false })
    const [system, prompt] = generate.mock.calls[0] as unknown as [string, string]
    expect(system).toContain('triggers:')
    expect(system).toContain('Jev (intent and ask) is not available here')
    expect(prompt).toContain('Brief: when I say push the changes')
    expect(prompt).toContain('title: Example')
  })

  it('offers intent and ask only when Jev can answer', async () => {
    const generate = vi.fn(async () => GOOD)
    await draftPlaybook({ brief: 'x', taken: [], examples: [], jev: true }, generate)
    const [system] = generate.mock.calls[0] as unknown as [string]
    expect(system).toContain('intent is one of')
    expect(system).toContain('Refer to the message as `latest`')
  })

  it('keeps the name when changing an existing playbook, and sends the current file', async () => {
    const generate = vi.fn(async () => GOOD.replace('push the changes', 'ship it now'))
    const r = await draftPlaybook({ brief: 'also when I say ship it now', current: { id: 'push', source: GOOD }, taken: ['push'], examples: [], jev: false }, generate)
    expect(r).toMatchObject({ ok: true, id: 'push' })
    expect((generate.mock.calls[0] as unknown as [string, string])[1]).toContain('The current file (push.md)')
  })

  it('gives a draft that does not load one repair round with the errors, then gives up', async () => {
    const bad = GOOD.replace('goal: Offer', 'chance: 0.3\ngoal: Offer')
    const generate = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(GOOD)
    const r = await draftPlaybook({ brief: 'x', taken: [], examples: [], jev: false }, generate)
    expect(r).toMatchObject({ ok: true, repaired: true })
    expect((generate.mock.calls[1] as unknown as [string, string])[1]).toContain('unknown field "chance"')

    const always = vi.fn(async () => bad)
    const r2 = await draftPlaybook({ brief: 'x', taken: [], examples: [], jev: false }, always)
    expect(r2.ok).toBe(false)
    expect(always).toHaveBeenCalledTimes(2)
  })
})

describe('extractFile and idFromTitle', () => {
  it('keeps only the file from a fenced or chatty answer', () => {
    expect(extractFile('Here you go:\n```yaml\n---\ntitle: X\n---\nBody\n```\nHope that helps')).toBe('---\ntitle: X\n---\nBody\n')
    expect(extractFile('Sure.\n---\ntitle: X\n---\nB')).toBe('---\ntitle: X\n---\nB\n')
  })

  it('makes a file name from a title', () => {
    expect(idFromTitle('Push after work!', [])).toBe('push-after-work')
    expect(idFromTitle('???', [])).toBe('playbook')
  })
})
