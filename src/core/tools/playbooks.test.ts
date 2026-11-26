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

  it('switches and undoes by voice', async () => {
    const { run, admin } = setup()
    expect(await run('playbook_switch', { id: 'break down long messages', on: false })).toMatchObject({ status: 'off', id: 'long-message-breakdown' })
    expect(admin.toggle).toHaveBeenCalledWith('long-message-breakdown', false, 'voice')
    expect(await run('playbook_undo', {})).toEqual({ ok: true, message: 'Undid: Save push.' })
  })
})

describe('triggerSummary', () => {
  it('says what a playbook reacts to in words', () => {
    expect(triggerSummary(info({ when: 'chars > 1', said: ['push it now'], ask: 'Is `latest` a push?' }))).toBe('when chars > 1, and when you say "push it now", and when Jev answers yes to "Is `latest` a push?"')
    expect(triggerSummary(info({}))).toBe('on every message')
  })
})
