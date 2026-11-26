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

describe('PlaybooksView', () => {
  it('lists playbooks with their triggers and firings, and a broken file with its error', async () => {
    await render()
    expect(host.textContent).toContain('1 playbook, 1 on')
    expect(host.textContent).toContain('1 could not be read')
    expect(host.textContent).toContain('chars > tuning.longMessageChars')
    expect(host.textContent).toContain('fired 2× · 2 min ago')
    expect(host.textContent).toContain('Not loaded: line 1: the file must start with a header')
    // the first one is open in the editor
    expect((host.querySelector('textarea[aria-label="editor"]') as HTMLTextAreaElement).value).toBe(SOURCE)
    expect(host.textContent).toContain('saved')
  })

  it('switches a playbook off from the list', async () => {
    await render()
    await click(host.querySelector('button[aria-pressed="true"]')!)
    expect(playbooks.toggle).toHaveBeenCalledWith('long-message-breakdown', false)
  })

  it('checks edits as you type and only offers Save when the file loads', async () => {
    await render()
    const editor = host.querySelector('textarea[aria-label="editor"]') as HTMLTextAreaElement
    playbooks.check.mockResolvedValueOnce({ errors: [{ line: 4, message: 'unknown field "chance"' }], warnings: [] })
    await type(editor, `${SOURCE}x`)
    await wait(250)
    expect(host.textContent).toContain('line 4unknown field "chance"')
    expect(button('Save')!.disabled).toBe(true)

    await type(editor, `${SOURCE}y`)
    await wait(250)
    expect(host.textContent).toContain('unsaved changes')
    expect(button('Save')!.disabled).toBe(false)
    await click(button('Save'))
    expect(playbooks.save).toHaveBeenCalledWith('long-message-breakdown', `${SOURCE}y`, 'long-message-breakdown')
  })

  it('tests a draft against recent messages and shows why each matched', async () => {
    await render()
    await click(button('Test on recent messages'))
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
    await click(button('New playbook'))
    expect((host.querySelector('input[aria-label="File name"]') as HTMLInputElement).value).toBe('new-playbook')
    expect(host.textContent).toContain('New, not saved yet')
    await wait(250)
    await click(button('Save'))
    expect(playbooks.save).toHaveBeenCalledWith('new-playbook', expect.stringContaining('title: New playbook'), undefined)
  })
})

describe('PlaybooksView with Jev playbooks', () => {
  it('says when Jev playbooks cannot fire for want of a key, and shows what they ask', async () => {
    const jevBook: PlaybookInfo = { ...good, id: 'idea', title: 'Idea, not instruction', when: 'intent == "idea"', usesJev: true, ask: null, firedCount: 0, lastFiredAt: null }
    const asker: PlaybookInfo = { ...good, id: 'push', title: 'Push', when: null, said: ['push changes'], ask: 'Is `latest` asking to push now?', usesJev: true, firedCount: 0, lastFiredAt: null }
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [jevBook, asker], jev: 'no_key' })
    await render()
    expect(host.textContent).toContain('2 playbooks need Jev to fire, and there is no TypeSafe key yet')
    expect(host.textContent).toContain('Jev: Is `latest` asking to push now?')
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [jevBook], jev: 'ready' })
    await act(async () => useStore.setState({ playbooksVersion: 1 }))
    await wait(0)
    expect(host.textContent).not.toContain('need Jev to fire')
  })

  it('shows how Jev took part in a test run', async () => {
    playbooks.test.mockResolvedValueOnce({ errors: [], rows: [{ text: 'maybe a spend tab', createdAt: 1, why: 'when intent == "idea" (intent "idea" at 0.82)' }], jevNote: 'Jev read your last 1 messages one by one, without the conversation around them, about $0.0000.' } as never)
    await render()
    await click(button('Test on recent messages'))
    expect(host.textContent).toContain('Jev read your last 1 messages one by one')
    expect(host.textContent).toContain('(intent "idea" at 0.82)')
  })
})

describe('PlaybooksView with runbooks', () => {
  const rb: PlaybookInfo = { ...good, id: 'brain-dump-to-tasks', title: 'Brain dump to tasks', kind: 'runbook', stepCount: 6, diagram: 'flowchart TD\n  start((start))', firedCount: 1, lastFiredAt: Date.now() }
  const run = (over: Partial<RunbookRun>): RunbookRun => ({ runId: 'r1', runbookId: 'brain-dump-to-tasks', title: 'Brain dump to tasks', status: 'waiting', step: 'reply', scratch: {}, log: [{ step: 'tasks', kind: 'model', outcome: 'ok', ms: 1400, note: '2 items', at: 1 }], startedAt: Date.now() - 30_000, updatedAt: Date.now(), activeMs: 1500, steps: 3, consented: false, waiting: { since: Date.now(), expiresAt: Date.now() + 60_000, save: 'reply', question: 'Add the 2 tasks?' }, ...over })

  it('marks runbooks, draws their steps, lists their runs and cancels a waiting one', async () => {
    playbooks.list.mockResolvedValueOnce({ dir: '/d', playbooks: [rb], jev: 'ready' })
    runbooks.runs.mockResolvedValue([run({}), run({ runId: 'r0', status: 'done', waiting: undefined, startedAt: Date.now() - 3_600_000 })])
    await render()
    await wait(200)
    expect(host.textContent).toContain('runbook · 6 steps')
    expect(host.querySelector('[data-testid="diagram"]')!.textContent).toContain('flowchart TD')
    expect(host.textContent).toContain('Running now')
    expect(host.textContent).toContain('waiting for your reply')
    expect(host.textContent).toContain('Asked: “Add the 2 tasks?”')
    expect(host.textContent).toContain('done')
    await click(button('Steps'))
    expect(host.textContent).toContain('tasks (model): 2 items')
    await click(button('Cancel'))
    expect(runbooks.cancel).toHaveBeenCalledWith('r1')
    runbooks.runs.mockResolvedValue([])
  })
})

describe('PlaybooksView review', () => {
  it('reviews the trigger, shows only the problems, takes marks, and drafts a tighter trigger into the editor', async () => {
    await render()
    await click(button('Review'))
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
    expect((host.querySelector('textarea[aria-label="editor"]') as HTMLTextAreaElement).value).toBe(`${SOURCE}# tighter\n`)
    expect(host.textContent).toContain('unsaved changes')
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
