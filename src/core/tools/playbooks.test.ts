import { describe, expect, it, vi } from 'vitest'
import type { PlaybookInfo, PlaybooksState } from '@shared/types'
import { CONFIRM_WINDOW_MS, playbookTools, triggerSummary, type PlaybookAdmin } from './playbooks'

const info = (over: Partial<PlaybookInfo>): PlaybookInfo => ({ id: 'x', source: '---\ntitle: X\n---\nB\n', ok: true, errors: [], warnings: [], title: 'X', goal: 'g', enabled: true, when: null, said: [], ask: null, usesJev: false, firedCount: 0, lastFiredAt: null, ...over })

function setup(list: PlaybookInfo[] = [info({ id: 'long-message-breakdown', title: 'Break down long messages', when: 'chars > 1200' })], jev: PlaybooksState['jev'] = 'ready') {
  let playbooks = [...list]
  const admin: PlaybookAdmin = {
    state: () => ({ dir: '/d', playbooks, jev }),
    save: vi.fn((id: string, text: string, previousId?: string) => {
      playbooks = playbooks.filter((p) => p.id !== previousId && p.id !== id).concat(info({ id, source: text, title: /title: (.+)/.exec(text)?.[1], said: ['push the changes'] }))
      return { ok: true as const, id }
    }),
    toggle: vi.fn((id: string) => ({ ok: true as const, id })),
    delete: vi.fn(),
    undo: vi.fn(async () => ({ ok: true, message: 'Undid: Save push.' }))
  }
  const draft = vi.fn(async () => ({ ok: true as const, id: 'push-after-work', text: '---\ntitle: Push after work\n---\nOffer to push.\n', repaired: false, warnings: [] }))
  const replay = vi.fn(async () => [{ text: 'a', createdAt: 1, why: 'said "push the changes"' }, { text: 'b', createdAt: 2, why: null }])
  let t = 0
  const tools = playbookTools({ admin, draft, replay, now: () => t })
  const run = (name: string, input: unknown) => (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {})
  return { admin, draft, replay, run, advance: (ms: number) => (t += ms) }
}

describe('playbook tools', () => {
  it('lists playbooks with what each reacts to, and whether Jev is there', async () => {
    const { run } = setup(undefined, 'no_key')
    expect(await run('playbook_list', {})).toEqual({
      playbooks: [{ id: 'long-message-breakdown', title: 'Break down long messages', on: true, fires: 'when chars > 1200', goal: 'g', needs_jev: false, fired_this_run: 0 }],
      jev: 'no TypeSafe key, so playbooks that need Jev never fire'
    })
  })

  it('creates one from a brief, saves it by voice, and says how often it would have fired lately', async () => {
    const { run, draft, admin } = setup()
    const out = await run('playbook_write', { brief: 'when I say push the changes, offer to push them' })
    expect(draft).toHaveBeenCalledWith('when I say push the changes, offer to push them', undefined)
    expect(admin.save).toHaveBeenCalledWith('push-after-work', expect.stringContaining('Push after work'), undefined, 'voice')
    expect(out).toMatchObject({ status: 'created', id: 'push-after-work', title: 'Push after work', fires: 'when you say "push the changes"', recent: "would have fired on 1 of the user's last 2 messages" })
  })

  it('changes an existing one by name or title, and saves nothing when the draft does not load', async () => {
    const { run, draft, admin } = setup()
    await run('playbook_write', { brief: 'only above 2000 characters', id: 'Break down long messages' })
    expect(draft).toHaveBeenCalledWith('only above 2000 characters', { id: 'long-message-breakdown', source: expect.any(String) })
    draft.mockResolvedValueOnce({ ok: false, errors: [{ line: 4, message: 'unknown field "chance"' }], text: '' } as never)
    vi.mocked(admin.save).mockClear()
    expect(await run('playbook_write', { brief: 'something odd here' })).toMatchObject({ status: 'invalid', errors: ['line 4: unknown field "chance"'] })
    expect(admin.save).not.toHaveBeenCalled()
    expect(await run('playbook_write', { brief: 'change the thing', id: 'nope' })).toMatchObject({ status: 'not_found' })
  })

  it('warns when the new playbook needs Jev and Jev is not available', async () => {
    const { run, admin } = setup(undefined, 'no_key')
    vi.mocked(admin.save).mockImplementationOnce((id: string) => {
      ;(admin.state as unknown as () => PlaybooksState) = () => ({ dir: '/d', jev: 'no_key', playbooks: [info({ id, title: 'Idea', when: 'intent == "idea"', usesJev: true })] })
      return { ok: true, id }
    })
    expect(await run('playbook_write', { brief: 'when I am only musing, do not start work' })).toMatchObject({ needs_jev: true, note: expect.stringContaining('will not fire') })
  })

  it('deletes only after a confirmed second call within the window', async () => {
    const { run, admin, advance } = setup()
    // a yes without the first call deletes nothing, and says so loudly
    expect(await run('playbook_delete', { id: 'long-message-breakdown', confirmed: true })).toMatchObject({ status: 'not_deleted', note: expect.stringContaining('NOT deleted') })
    expect(admin.delete).not.toHaveBeenCalled()
    advance(CONFIRM_WINDOW_MS + 1)
    expect(await run('playbook_delete', { id: 'long-message-breakdown', confirmed: true })).toMatchObject({ status: 'not_deleted' })
    expect(await run('playbook_delete', { id: 'long-message-breakdown' })).toMatchObject({ status: 'needs_confirmation' })
    advance(5000)
    expect(await run('playbook_delete', { id: 'long-message-breakdown', confirmed: true })).toMatchObject({ status: 'deleted' })
    expect(admin.delete).toHaveBeenCalledWith('long-message-breakdown', 'voice')
  })

  it('remembers a delete question across turns, when the tools are rebuilt', async () => {
    const { admin } = setup()
    const pendingDeletes = new Map<string, number>()
    const turn = () => playbookTools({ admin, draft: vi.fn(), pendingDeletes, now: () => 1000 })
    const call = (tools: ReturnType<typeof turn>, input: unknown) => (tools.playbook_delete as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {})
    expect(await call(turn(), { id: 'long-message-breakdown' })).toMatchObject({ status: 'needs_confirmation' })
    expect(await call(turn(), { id: 'long-message-breakdown', confirmed: true })).toMatchObject({ status: 'deleted' })
  })

  it('finds a playbook by its spoken name, hyphens as spaces and words in any order', async () => {
    const { run } = setup()
    expect(await run('playbook_switch', { id: 'long message breakdown', on: false })).toMatchObject({ status: 'off', id: 'long-message-breakdown' })
    expect(await run('playbook_switch', { id: 'the breakdown playbook for long messages', on: true })).toMatchObject({ status: 'on', id: 'long-message-breakdown' })
    expect(await run('playbook_switch', { id: 'something else entirely', on: true })).toMatchObject({ status: 'not_found' })
  })

  it('switches and undoes by voice', async () => {
    const { run, admin } = setup()
    expect(await run('playbook_switch', { id: 'break down long messages', on: false })).toMatchObject({ status: 'off', id: 'long-message-breakdown' })
    expect(admin.toggle).toHaveBeenCalledWith('long-message-breakdown', false, 'voice')
    expect(await run('playbook_undo', {})).toEqual({ ok: true, message: 'Undid: Save push.' })
  })
})

describe('review, fix and mark by voice', () => {
  const row = (id: string, text: string, verdict: 'agree' | 'miss' | 'false_fire' | 'unsure', fires: boolean) => ({ messageId: id, text, createdAt: 1, fires, why: null, should: null, p: null, by: 'jev' as const, verdict })
  function reviewSetup(previous?: { id: string; text: string; playbooks?: Array<{ id: string; title: string; why: string }> }) {
    const t = setup([info({ id: 'push', title: 'Push', said: ['push the changes'] }), info({ id: 'idea', title: 'Idea' })])
    const admin = t.admin as PlaybookAdmin
    admin.evaluate = vi.fn(async () => ({ errors: [], rows: [row('a', 'ship it to github', 'miss', false), row('b', 'push the notes', 'false_fire', true), row('c', 'push the changes', 'agree', true)], summary: { checked: 3, fires: 2, agree: 1, misses: 1, falseFires: 1, unsure: 0 }, note: 'Jev judged 3 messages.' }))
    admin.suggest = vi.fn(async () => ({ ok: true as const, id: 'push', text: '---\ntitle: Push\n---\nx\n', repaired: false, warnings: [] }))
    admin.label = vi.fn()
    admin.previousUserMessage = () => (previous ? { ...previous, turnId: 't', sessionId: 's', role: 'user' as const, createdAt: 1 } : undefined)
    const tools = playbookTools({ admin, draft: vi.fn() })
    const run = (name: string, input: unknown) => (tools[name] as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {})
    return { admin, run }
  }

  it('reviews a playbook and names what it missed and where it fired wrongly', async () => {
    const { run } = reviewSetup()
    expect(await run('playbook_review', { id: 'push' })).toMatchObject({ id: 'push', checked: 3, fired_on: 2, agreed: 1, missed: ['ship it to github'], fired_wrongly: ['push the notes'], next: 'Offer to tighten the trigger (playbook_fix).' })
  })

  it('fixes the trigger by saving the suggestion, by voice', async () => {
    const { run, admin } = reviewSetup()
    expect(await run('playbook_fix', { id: 'Push' })).toMatchObject({ status: 'changed', id: 'push' })
    expect(admin.save).toHaveBeenCalledWith('push', expect.stringContaining('title: Push'), undefined, 'voice')
  })

  it('marks the previous message for the one playbook that fired there, and asks when it is not clear which', async () => {
    const one = reviewSetup({ id: 'm1', text: 'push the notes', playbooks: [{ id: 'push', title: 'Push', why: 'x' }] })
    expect(await one.run('playbook_mark', { verdict: 'should_not' })).toMatchObject({ status: 'marked', id: 'push' })
    expect(one.admin.label).toHaveBeenCalledWith('push', 'm1', 'should_not')
    const none = reviewSetup({ id: 'm2', text: 'hello' })
    expect(await none.run('playbook_mark', { verdict: 'should' })).toMatchObject({ status: 'which' })
    expect(await none.run('playbook_mark', { verdict: 'should', id: 'idea' })).toMatchObject({ status: 'marked', id: 'idea' })
  })
})

describe('triggerSummary', () => {
  it('says what a playbook reacts to in words', () => {
    expect(triggerSummary(info({ when: 'chars > 1', said: ['push it now'], ask: 'Is `latest` a push?' }))).toBe('when chars > 1, and when you say "push it now", and when Jev answers yes to "Is `latest` a push?"')
    expect(triggerSummary(info({}))).toBe('on every message')
  })
})
