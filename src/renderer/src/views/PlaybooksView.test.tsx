import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, PlaybookCheck, PlaybookInfo, PlaybooksState, RunbookRun } from '@shared/types'

vi.mock('../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))
// Mermaid needs layout jsdom does not have; the diagram's code stands in for it
vi.mock('../components/diagram/DiagramCard', () => ({ InlineDiagram: ({ code }: { code: string }) => <pre data-testid="diagram">{code}</pre> }))
// CodeMirror needs layout jsdom does not have; a textarea stands in for it
vi.mock('./claude/CodeEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (t: string) => void }) => <textarea aria-label="editor" value={value} onChange={(e) => onChange?.(e.target.value)} />
}))

const SOURCE = '---\ntitle: Break down long messages\ngoal: x\n---\nBody.\n'
const good: PlaybookInfo = {
  id: 'long-message-breakdown', source: SOURCE, ok: true, errors: [], warnings: [], title: 'Break down long messages', goal: 'x', enabled: true, priority: 'normal',
  events: ['turn.user'], when: 'chars > tuning.longMessageChars', said: [], cooldownS: 0, maxPerSession: null, tags: [], firedCount: 2, lastFiredAt: Date.now() - 120_000
}
const broken: PlaybookInfo = { id: 'broken', source: 'no header', ok: false, errors: [{ line: 1, message: 'the file must start with a header between two --- lines' }], warnings: [], firedCount: 0, lastFiredAt: null }

const playbooks = {
  list: vi.fn(async (): Promise<PlaybooksState> => ({ dir: '/data/playbooks', playbooks: [good, broken], jev: 'no_key' })),
  check: vi.fn(async (): Promise<PlaybookCheck> => ({ errors: [], warnings: [] })),
  save: vi.fn(async (id: string) => ({ ok: true as const, id })),
  toggle: vi.fn(async (id: string) => ({ ok: true as const, id })),
  delete: vi.fn(async () => undefined),
  evaluate: vi.fn(async () => ({
    errors: [],
    rows: [
      { messageId: 'm1', text: 'ship it to github', createdAt: 1, fires: false, why: null, should: true, p: 0.91, by: 'jev' as const, verdict: 'miss' as const },
      { messageId: 'm2', text: 'push the notes wording', createdAt: 2, fires: true, why: 'said', should: false, p: 0.08, by: 'jev' as const, verdict: 'false_fire' as const },
      { messageId: 'm3', text: 'a quiet hello', createdAt: 3, fires: false, why: null, should: false, p: 0.02, by: 'jev' as const, verdict: 'agree' as const }
    ],
    summary: { checked: 3, fires: 1, agree: 1, misses: 1, falseFires: 1, unsure: 0 },
    note: 'Jev judged 3 messages, about $0.0001.'
  })),
  label: vi.fn(async () => undefined),
  suggest: vi.fn(async () => ({ ok: true as const, id: 'long-message-breakdown', text: `${SOURCE}# tighter\n`, repaired: false, warnings: [] })),
  test: vi.fn(async () => ({ errors: [], rows: [{ text: 'a very long ramble', createdAt: 1, why: 'when chars > 1200 (chars 1500)' }, { text: 'just saying hello there', createdAt: 2, why: null }] })),
  openFolder: vi.fn(async () => undefined)
}
;const runbooks = { runs: vi.fn(async (): Promise<RunbookRun[]> => []), cancel: vi.fn(async () => true) }
;(globalThis as { window: { api?: unknown } }).window.api = { playbooks, runbooks }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useStore } = await import('../state/store')
const { PlaybooksView } = await import('./PlaybooksView')
const { Transcript } = await import('../components/chat/Transcript')

let root: Root
let host: HTMLDivElement
const render = async (el: React.ReactElement = <PlaybooksView />) => {
  await act(async () => root.render(el))
  await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const click = async (el: Element | undefined) => {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}
const type = async (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const wait = (ms: number) => act(async () => new Promise((r) => setTimeout(r, ms)))

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({ view: 'playbooks', playbookFocus: null, playbooksVersion: 0 })
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const tab = (name: string) => [...host.querySelectorAll('button[role="tab"]')].find((b) => b.textContent?.startsWith(name)) as HTMLButtonElement
const editor = () => host.querySelector('textarea[aria-label="editor"]') as HTMLTextAreaElement
const titleInput = () => host.querySelector('input[aria-label="Title"]') as HTMLInputElement
const RB_SOURCE = '---\nkind: runbook\ntitle: Brain dump to tasks\ngoal: x\ntriggers:\n  said: ["brain dump"]\nsteps:\n  - id: tasks\n    do: model\n    prompt: "List the tasks in {{text}}"\n    save: tasks\n---\nNotes.\n'

describe('PlaybooksView', () => {
  it('lists playbooks in groups with their triggers and firings, and a broken file with its error', async () => {
    await render()
    expect(host.textContent).toContain('1 loaded · 1 on')
    expect(host.textContent).toContain('1 broken')
    expect(host.textContent).toContain('Can’t be read')
    expect(host.textContent).toContain('chars > tuning.longMessageChars')
    expect(host.textContent).toContain('fired 2×')
    expect(host.textContent).toContain('line 1: the file must start with a header')
    // the first one is open, on the Setup form, with its title in the header
    expect(titleInput().value).toBe('Break down long messages')
    expect(host.querySelector('[data-testid="trigger-summary"]')!.textContent).toContain('It fires when you say something, on every message')
    expect(host.textContent).toContain('saved')
  })

  it('switches a playbook off from the list', async () => {
    await render()
    await click(host.querySelector('aside button[aria-pressed="true"]')!)
    expect(playbooks.toggle).toHaveBeenCalledWith('long-message-breakdown', false)
  })

  it('searches and filters the list', async () => {
    await render()
    await type(host.querySelector('input[aria-label="Search playbooks"]') as HTMLInputElement, 'zebra')
    expect(host.textContent).toContain('Nothing matches “zebra”')
    await click(button('Show everything'))
    await click([...host.querySelectorAll('aside button[role="tab"]')].find((b) => b.textContent?.startsWith('Problems')))
    expect(host.querySelector('[data-playbook="long-message-breakdown"]')).toBeNull()
    expect(host.querySelector('[data-playbook="broken"]')).toBeTruthy()
  })

  it('edits the trigger through the form, which rewrites the file, and saves it', async () => {
    await render()
    const phrase = host.querySelector('input[aria-label="Add a phrase"]') as HTMLInputElement
    await type(phrase, 'break it down')
    await act(async () => phrase.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(host.querySelector('[data-testid="trigger-summary"]')!.textContent).toContain('you use every word of “break it down”')
    expect(host.textContent).toContain('Unsaved changes')
    await click(tab('File'))
    expect(editor().value).toContain('said:')
    expect(editor().value).toContain('break it down')
    await wait(250)
    await click(button('Save'))
    expect(playbooks.save).toHaveBeenCalledWith('long-message-breakdown', expect.stringContaining('break it down'), 'long-message-breakdown')
  })

  it('checks edits as you type and will not save a file with problems', async () => {
    await render()
    await click(tab('File'))
    playbooks.check.mockResolvedValueOnce({ errors: [{ line: 4, message: 'unknown field "chance"' }], warnings: [] })
    await type(editor(), `${SOURCE}x`)
    await wait(250)
    expect(host.textContent).toContain('line 4unknown field "chance"')
    expect(host.textContent).toContain('1 problem to fix first')
    expect(button('Save')!.disabled).toBe(true)

    await type(editor(), `${SOURCE}y`)
    await wait(250)
    expect(button('Save')!.disabled).toBe(false)
    await click(button('Save'))
    expect(playbooks.save).toHaveBeenCalledWith('long-message-breakdown', `${SOURCE}y`, 'long-message-breakdown')
  })

  it('keeps unsaved edits when you look at another one, and reverts them', async () => {
    const other: PlaybookInfo = { ...good, id: 'another', title: 'Zed one', source: SOURCE.replace('Break down long messages', 'Zed one'), firedCount: 0, lastFiredAt: null }
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [good, other], jev: 'ready' })
    await render()
    await type(titleInput(), 'Break it up')
    await click(host.querySelector('[data-playbook="another"]')!)
    expect(titleInput().value).toBe('Zed one')
    expect(host.querySelector('[data-playbook="long-message-breakdown"] [title="Unsaved changes"]')).toBeTruthy()
    await click(host.querySelector('[data-playbook="long-message-breakdown"]')!)
    expect(titleInput().value).toBe('Break it up')
    await click(button('Revert'))
    expect(titleInput().value).toBe('Break down long messages')
  })

  it('tests a draft against recent messages and shows why each matched', async () => {
    await render()
    await click(tab('Check'))
    await click(button('Run test'))
    expect(host.textContent).toContain('1 of your last 2 messages would have set it off')
    expect(host.textContent).toContain('when chars > 1200 (chars 1500)')
    expect(host.textContent).not.toContain('just saying hello there')
    await click(button('Show all'))
    expect(host.textContent).toContain('just saying hello there')
  })

  it('asks for a second click before deleting', async () => {
    await render()
    await click(button('Delete'))
    expect(playbooks.delete).not.toHaveBeenCalled()
    await click(button('Click again to delete'))
    expect(playbooks.delete).toHaveBeenCalledWith('long-message-breakdown')
  })

  it('starts a new playbook from the skeleton with a free name, saved as a new file', async () => {
    await render()
    await click([...host.querySelectorAll('aside button')].find((b) => b.textContent === 'Playbook'))
    expect((host.querySelector('input[aria-label="File name"]') as HTMLInputElement).value).toBe('new-playbook')
    expect(host.textContent).toContain('New playbook, not saved yet')
    await wait(250)
    await click(button('Save'))
    expect(playbooks.save).toHaveBeenCalledWith('new-playbook', expect.stringContaining('title: New playbook'), undefined)
  })

  it('welcomes you when there are none yet', async () => {
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [], jev: 'ready' })
    await render()
    expect(host.textContent).toContain('Teach the assistant how to handle things')
    await click(button('New runbook'))
    expect((host.querySelector('input[aria-label="File name"]') as HTMLInputElement).value).toBe('new-runbook')
  })
})

describe('PlaybooksView with Jev playbooks', () => {
  it('says when Jev playbooks cannot fire for want of a key, and shows what they ask', async () => {
    const jevBook: PlaybookInfo = { ...good, id: 'idea', title: 'Idea, not instruction', when: 'intent == "idea"', usesJev: true, ask: null, firedCount: 0, lastFiredAt: null }
    const asker: PlaybookInfo = { ...good, id: 'push', title: 'Push', when: null, said: ['push changes'], ask: 'Is `latest` asking to push now?', usesJev: true, firedCount: 0, lastFiredAt: null }
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [jevBook, asker], jev: 'no_key' })
    await render()
    expect(host.textContent).toContain('2 need Jev to fire, and there is no TypeSafe key yet')
    expect(host.textContent).toContain('Jev: Is `latest` asking to push now?')
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [jevBook], jev: 'ready' })
    await act(async () => useStore.setState({ playbooksVersion: 1 }))
    await wait(0)
    expect(host.textContent).not.toContain('need Jev to fire')
  })

  it('shows how Jev took part in a test run', async () => {
    playbooks.test.mockResolvedValueOnce({ errors: [], rows: [{ text: 'maybe a spend tab', createdAt: 1, why: 'when intent == "idea" (intent "idea" at 0.82)' }], jevNote: 'Jev read your last 1 messages one by one, without the conversation around them, about $0.0000.' } as never)
    await render()
    await click(tab('Check'))
    await click(button('Run test'))
    expect(host.textContent).toContain('Jev read your last 1 messages one by one')
    expect(host.textContent).toContain('(intent "idea" at 0.82)')
  })
})

describe('PlaybooksView with runbooks', () => {
  const rb: PlaybookInfo = { ...good, id: 'brain-dump-to-tasks', source: RB_SOURCE, title: 'Brain dump to tasks', kind: 'runbook', stepCount: 1, diagram: 'flowchart TD\n  start((start))', firedCount: 1, lastFiredAt: Date.now() }
  const run = (over: Partial<RunbookRun>): RunbookRun => ({ runId: 'r1', runbookId: 'brain-dump-to-tasks', title: 'Brain dump to tasks', status: 'waiting', step: 'reply', scratch: {}, log: [{ step: 'tasks', kind: 'model', outcome: 'ok', ms: 1400, note: '2 items', at: 1 }], startedAt: Date.now() - 30_000, updatedAt: Date.now(), activeMs: 1500, steps: 3, consented: false, waiting: { since: Date.now(), expiresAt: Date.now() + 60_000, save: 'reply', question: 'Add the 2 tasks?' }, ...over })

  it('shows what is running in the sidebar, lists the runs and cancels a waiting one', async () => {
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [rb], jev: 'ready' })
    runbooks.runs.mockResolvedValue([run({}), run({ runId: 'r0', status: 'done', waiting: undefined, startedAt: Date.now() - 3_600_000 })])
    await render()
    await wait(200)
    expect(host.textContent).toContain('Running now')
    expect(host.textContent).toContain('waiting for your reply · step 3')
    await click(button('Brain dump to taskswaiting'))
    expect(tab('Activity').getAttribute('aria-selected')).toBe('true')
    expect(host.textContent).toContain('Asked: “Add the 2 tasks?”')
    expect(host.textContent).toContain('1 of 2')
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Steps'))
    expect(host.textContent).toContain('tasks (model): 2 items')
    await click(button('Cancel'))
    expect(runbooks.cancel).toHaveBeenCalledWith('r1')
    runbooks.runs.mockResolvedValue([])
  })

  it('builds steps with a live flowchart, and renames a step everywhere it is used', async () => {
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [rb], jev: 'ready' })
    playbooks.check.mockResolvedValue({ errors: [], warnings: [], diagram: 'flowchart TD\n  tasks' })
    await render()
    await click(tab('Steps'))
    await wait(250)
    expect(host.querySelector('[data-testid="diagram"]')!.textContent).toContain('flowchart TD')
    expect((host.querySelector('textarea[aria-label="tasks prompt"]') as HTMLTextAreaElement).value).toBe('List the tasks in {{text}}')
    await click(button('CheckBranch on a condition'))
    expect(host.querySelector('[data-step="check"]')).toBeTruthy()
    // point the check's yes branch at the first step, then rename that step
    const yes = host.querySelector('select[aria-label="check yes"]') as HTMLSelectElement
    await act(async () => {
      yes.value = 'tasks'
      yes.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const id = host.querySelector('[data-step="tasks"] input[aria-label="Step id"]') as HTMLInputElement
    await type(id, 'pull')
    await act(async () => id.dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    await click(tab('File'))
    expect(editor().value).toContain('id: pull')
    expect(editor().value).toContain('yes: pull')
    expect(editor().value).not.toContain('id: tasks')
    playbooks.check.mockImplementation(async () => ({ errors: [], warnings: [] }))
  })
})

describe('PlaybooksView review', () => {
  it('reviews the trigger, shows only the problems, takes marks, and drafts a tighter trigger', async () => {
    await render()
    await click(tab('Check'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Review'))
    expect(playbooks.evaluate).toHaveBeenCalledWith('long-message-breakdown', SOURCE)
    expect(host.textContent).toContain('Of your last 3 messages it fires on 1. Right on 1, missed 1, fired wrongly on 1.')
    expect(host.textContent).toContain('ship it to github')
    expect(host.textContent).not.toContain('a quiet hello')
    expect(host.textContent).toContain('Jev says it should (0.91)')

    // marking the false fire as fine after all turns it into a right one
    const rowOf = (text: string) => [...host.querySelectorAll('div')].find((d) => d.textContent?.startsWith('fired wrongly') && d.textContent.includes(text))!
    await click([...rowOf('push the notes wording').querySelectorAll('button')].find((b) => b.textContent === 'Should fire'))
    expect(playbooks.label).toHaveBeenCalledWith('long-message-breakdown', 'm2', 'should')
    expect(host.textContent).toContain('Right on 2, missed 1.')

    await click(button('Suggest a tighter trigger'))
    expect(playbooks.suggest).toHaveBeenCalledWith('long-message-breakdown', SOURCE)
    expect(host.textContent).toContain('Unsaved changes')
    await click(tab('File'))
    expect(editor().value).toBe(`${SOURCE}# tighter\n`)
  })
})

describe('playbook chips in the chat', () => {
  it('shows a chip under the message that fired it, and the chip opens the playbook', async () => {
    const m: ChatMessage = { id: 'u1', turnId: 't1', sessionId: 's', role: 'user', text: 'a long ramble', via: 'voice', createdAt: 1, playbooks: [{ id: 'long-message-breakdown', title: 'Break down long messages', why: 'when chars > 1200' }] }
    useStore.setState({ messages: [m], view: 'chat' })
    await render(<Transcript />)
    const chip = button('Break down long messages')!
    expect(chip.title).toContain('when chars > 1200')
    await click(chip)
    expect(useStore.getState()).toMatchObject({ view: 'playbooks', playbookFocus: 'long-message-breakdown' })
    // the small control next to it marks a wrong firing, once
    useStore.setState({ view: 'chat' })
    const wrong = host.querySelector('button[aria-label="Break down long messages should not have fired here"]') as HTMLButtonElement
    await click(wrong)
    expect(playbooks.label).toHaveBeenCalledWith('long-message-breakdown', 'u1', 'should_not')
    expect(wrong.disabled).toBe(true)
  })
})

describe('Triggers', () => {
  const SCHED = '---\nkind: runbook\ntitle: Morning check\ngoal: x\ntriggers:\n  events: [schedule]\n  schedule: { at: ["09:00"], days: [mon, tue, wed, thu, fri] }\nsteps:\n  - { id: hi, do: say, text: hi }\n---\nNotes.\n'
  const CTX = '---\nkind: runbook\ntitle: Offer to compact\ngoal: x\ntriggers:\n  events: [cc.context]\n  when: "percent >= 80"\nsteps:\n  - { id: hi, do: say, text: hi }\n---\nNotes.\n'
  const sched: PlaybookInfo = { id: 'morning-check', source: SCHED, ok: true, errors: [], warnings: [], title: 'Morning check', goal: 'x', enabled: true, kind: 'runbook', events: ['schedule'], schedule: { at: ['09:00'], every: null, days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: null, until: null }, said: [], when: null, firedCount: 0, lastFiredAt: null }
  const ctx: PlaybookInfo = { id: 'offer-compact', source: CTX, ok: true, errors: [], warnings: [], title: 'Offer to compact', goal: 'x', enabled: true, kind: 'runbook', events: ['cc.context'], said: [], when: 'percent >= 80', firedCount: 1, lastFiredAt: Date.now() - 60_000, skippedCount: 1, lastSkip: { at: Date.now() - 5_000, reason: 'cooldown', by: 'cc.context' } }
  const state = (): PlaybooksState => ({
    dir: '/d', jev: 'ready', playbooks: [good, sched, ctx],
    activity: [
      { at: Date.now() - 5_000, id: 'offer-compact', title: 'Offer to compact', outcome: 'skipped', detail: 'cooldown', by: 'cc.context' },
      { at: Date.now() - 60_000, id: 'offer-compact', title: 'Offer to compact', outcome: 'fired', detail: 'cc.context and percent >= 80 (percent 82)', by: 'cc.context' }
    ]
  })

  it('shows every event with what listens to it, what each did, and a log of decisions', async () => {
    playbooks.list.mockResolvedValue(state())
    await render()
    await click(button('Triggers'))
    const view = host.querySelector('section[aria-label="Triggers overview"]')!
    expect(view).toBeTruthy()
    expect(view.querySelector('[data-event="cc.context"]')!.textContent).toContain('Offer to compact')
    expect(view.querySelector('[data-event="cc.context"]')!.textContent).toContain('held back 1×: still cooling down from its last firing')
    expect(view.querySelector('[data-event="schedule"]')!.textContent).toContain('at 09:00 on weekdays')
    expect(view.querySelector('[data-event="turn.user"]')!.textContent).toContain('fired 2×')
    expect(view.querySelector('[data-event="cc.error"]')!.textContent).toContain('Nothing reacts to this yet')
    const log = host.querySelector('[data-testid="trigger-log"]')!.textContent!
    expect(log).toContain('held back')
    expect(log).toContain('percent >= 80 (percent 82)')
    // a row opens its file
    await click(view.querySelector('[data-trigger="morning-check"]')!)
    expect(titleInput().value).toBe('Morning check')
    playbooks.list.mockImplementation(async () => ({ dir: '/data/playbooks', playbooks: [good, broken], jev: 'no_key' }))
  })

  it('starts a new runbook already set to an event', async () => {
    playbooks.list.mockResolvedValue(state())
    await render()
    await click(button('Triggers'))
    await click(host.querySelector('button[aria-label="New runbook on Its context fills up"]')!)
    await click(tab('File'))
    expect(editor().value).toContain('events:\n    - cc.context')
    expect(editor().value).toContain('percent >= 80')
    playbooks.list.mockImplementation(async () => ({ dir: '/data/playbooks', playbooks: [good, broken], jev: 'no_key' }))
  })

  it('edits a schedule: times, days, and the next runs; another event drops it', async () => {
    playbooks.list.mockResolvedValue(state())
    await render()
    await click(host.querySelector('[data-playbook="morning-check"]')!)
    expect(host.querySelector('[data-testid="trigger-summary"]')!.textContent).toContain('It runs at 09:00 on weekdays')
    expect(host.querySelector('[data-testid="next-runs"]')!.textContent).toMatch(/Next: .*09:00/)
    const time = host.querySelector('input[aria-label="Time to add"]') as HTMLInputElement
    await type(time, '17:30')
    await click(button('Add time'))
    await click(button('Weekends'))
    expect(host.querySelector('[data-testid="trigger-summary"]')!.textContent).toContain('It runs at 09:00 and 17:30 at weekends')
    await click([...host.querySelectorAll('button[role="radio"]')].find((b) => b.textContent?.startsWith('A session finishes')))
    await click(tab('File'))
    expect(editor().value).toContain('cc.finished')
    expect(editor().value).not.toContain('schedule')
    playbooks.list.mockImplementation(async () => ({ dir: '/data/playbooks', playbooks: [good, broken], jev: 'no_key' }))
  })
})
