import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CcSession } from '@shared/claude'
import type { Settings } from '@shared/types'

vi.mock('../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))

const ok = { ok: true }
const claude = {
  list: vi.fn(), events: vi.fn().mockResolvedValue([]), start: vi.fn(), send: vi.fn().mockResolvedValue({ ok: true, queued: false }),
  answer: vi.fn().mockResolvedValue({ ok: true, said: 'x' }), interrupt: vi.fn().mockResolvedValue(ok), stop: vi.fn().mockResolvedValue(ok), dequeue: vi.fn().mockResolvedValue(ok),
  rename: vi.fn().mockResolvedValue(ok), reset: vi.fn().mockResolvedValue(ok), remove: vi.fn().mockResolvedValue(ok), open: vi.fn().mockResolvedValue(ok),
  files: vi.fn().mockResolvedValue([]), read: vi.fn().mockResolvedValue({ kind: 'text', text: '', size: 0, truncated: false }),
}
;(globalThis as { window: { api?: unknown } }).window.api = { claude, settings: { set: vi.fn(async (p: object) => p) } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useStore } = await import('../state/store')
const { ClaudeView } = await import('./ClaudeView')
const { ClaudeStrip } = await import('../components/chat/ClaudeStrip')

const session = (over: Partial<CcSession> = {}): CcSession => ({
  id: 's1', name: 'Landing page', workspace: 'D:\\ws\\landing-page', status: 'idle', queued: [], lastSummary: 'Built it', costUsd: 0.02, turns: 2, createdAt: 1, updatedAt: 1, ...over,
})
const claudeSettings = { enabled: true, workspaceRoot: 'D:\\ws', model: '', maxSessions: 4, approveShell: true }

let root: Root
let host: HTMLDivElement
const render = async () => { await act(async () => { root.render(<ClaudeView />) }) }
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const click = async (el: Element | undefined) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }) }

beforeEach(() => {
  vi.clearAllMocks()
  // like the real manager, list() reflects whatever the test seeded into the store
  claude.list.mockImplementation(async () => useStore.getState().claudeSessions)
  claude.events.mockResolvedValue([])
  claude.files.mockResolvedValue([])
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({ settings: { claude: claudeSettings } as unknown as Settings, claudeSessions: [], claudeOutput: {}, claudeSelected: null })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('ClaudeView', () => {
  it('shows the enable card when voice control is off', async () => {
    useStore.setState({ settings: { claude: { ...claudeSettings, enabled: false } } as unknown as Settings })
    await render()
    expect(host.textContent).toContain('Voice control of Claude Code')
    expect(host.textContent).not.toContain('Sessions')
  })

  it('shows an empty state and the how-to guide with no sessions', async () => {
    await render()
    expect(host.textContent).toContain('No sessions yet')
    expect(host.textContent).toContain('How it works')
    expect(host.textContent).toContain('Hold on, stop that')
  })

  it('asks for a restart when the running app has no Claude backend yet', async () => {
    const api = (globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api
    const saved = api.claude
    delete api.claude
    try {
      await render()
      expect(host.textContent).toContain('Restart the app to load Claude Code')
    } finally {
      api.claude = saved
    }
  })

  it('the chat strip shows each session and opens it in the Claude view', async () => {
    const p = { id: 'p', kind: 'permission' as const, toolName: 'Bash', summary: 'Run: npm test' }
    useStore.setState({ view: 'chat', claudeSessions: [session(), session({ id: 's2', name: 'API', status: 'needs_permission', pending: p })], claudeSelected: 's1' })
    await act(async () => { root.render(<ClaudeStrip />) })
    expect(host.textContent).toContain('Landing page')
    expect(host.textContent).toContain('needs approval')
    await click(button('API'))
    expect(useStore.getState().view).toBe('claude')
    expect(useStore.getState().claudeSelected).toBe('s2')
  })

  it('renders a session with its output, and the interrupt/stop controls call the API', async () => {
    useStore.setState({ claudeSessions: [session({ status: 'running' })], claudeSelected: 's1', claudeOutput: { s1: [{ t: 1, kind: 'user', text: 'make a page' }, { t: 2, kind: 'tool', text: 'Write index.html' }, { t: 3, kind: 'denied', text: 'outside workspace' }] } })
    await render()
    expect(host.textContent).toContain('make a page')
    expect(host.textContent).toContain('Write index.html')
    expect(host.textContent).toContain('blocked')
    expect(host.textContent).toContain('working')
    await click(button('Interrupt'))
    expect(claude.interrupt).toHaveBeenCalledWith('s1', false)
    await click(button('Stop'))
    expect(claude.stop).toHaveBeenCalledWith('s1')
  })

  it('a single-choice question answers on tap with the 1-based option number', async () => {
    const pending = { id: 'p', kind: 'question' as const, toolName: 'AskUserQuestion' as const, summary: 'Which framework?', questions: [{ question: 'Which framework?', header: 'Stack', multiSelect: false, options: [{ label: 'React', description: 'popular' }, { label: 'Svelte' }] }] }
    useStore.setState({ claudeSessions: [session({ status: 'needs_input', pending })], claudeSelected: 's1' })
    await render()
    expect(host.textContent).toContain('Needs your answer')
    expect(host.textContent).toContain('1 React')
    await click(button('Svelte'))
    expect(claude.answer).toHaveBeenCalledWith('s1', { kind: 'choice', choices: [2] })
  })

  it('free text can answer a question', async () => {
    const pending = { id: 'p', kind: 'question' as const, toolName: 'AskUserQuestion' as const, summary: 'q', questions: [{ question: 'Which?', header: '', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] }
    useStore.setState({ claudeSessions: [session({ status: 'needs_input', pending })], claudeSelected: 's1' })
    await render()
    const input = host.querySelector('input[placeholder^="Or type"]') as HTMLInputElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'Rust')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(host.querySelector('button[type="submit"]') ?? undefined)
    expect(claude.answer).toHaveBeenCalledWith('s1', { kind: 'text', text: 'Rust' })
  })

  it('shows a shell approval with the command and approve/deny buttons', async () => {
    const pending = { id: 'p', kind: 'permission' as const, toolName: 'PowerShell', summary: 'Run: npm test' }
    useStore.setState({ claudeSessions: [session({ status: 'needs_permission', pending })], claudeSelected: 's1' })
    await render()
    expect(host.textContent).toContain('Run: npm test')
    expect(host.textContent).toContain('1 waiting on you')
    await click(button('Approve'))
    expect(claude.answer).toHaveBeenLastCalledWith('s1', { kind: 'allow' })
    await click(button('Deny'))
    expect(claude.answer).toHaveBeenLastCalledWith('s1', { kind: 'deny' })
  })

  it('lists queued prompts and removes one', async () => {
    useStore.setState({ claudeSessions: [session({ status: 'running', queued: ['first', 'second'] })], claudeSelected: 's1' })
    await render()
    expect(host.textContent).toContain('Queued (2)')
    await click(host.querySelectorAll('button[aria-label="Remove queued prompt"]')[1])
    expect(claude.dequeue).toHaveBeenCalledWith('s1', 1)
  })

  it('send now is offered only while busy', async () => {
    useStore.setState({ claudeSessions: [session({ status: 'idle' })], claudeSelected: 's1' })
    await render()
    expect(button('Send now')).toBeUndefined()
    expect(button('Send')).toBeTruthy()
    useStore.setState({ claudeSessions: [session({ status: 'running' })] })
    await render()
    expect(button('Send now')).toBeTruthy()
    expect(button('Queue')).toBeTruthy()
  })

  it('draws tool calls by kind: a terminal with its output, an edit as a diff, a todo list', async () => {
    const out = [
      { t: 1, kind: 'tool' as const, text: 'PowerShell npm test', tool: 'PowerShell', toolId: 'a', input: { command: 'npm test' } },
      { t: 2, kind: 'tool_result' as const, text: '3 passing', toolId: 'a' },
      { t: 3, kind: 'tool' as const, text: 'Edit x', tool: 'Edit', toolId: 'b', input: { file_path: 'D:\ws\landing-page\style.css', old_string: 'color: red', new_string: 'color: blue' } },
      { t: 4, kind: 'tool' as const, text: 'TodoWrite', tool: 'TodoWrite', input: { todos: [{ content: 'Build hero', status: 'completed' }, { content: 'Add form', status: 'in_progress' }] } },
      { t: 5, kind: 'text' as const, text: 'Made it **blue**.' },
      { t: 6, kind: 'result' as const, text: 'Made it **blue**.', durationMs: 65_000, costUsd: 0.05, turns: 3 }
    ]
    useStore.setState({ claudeSessions: [session()], claudeSelected: 's1', claudeOutput: { s1: out } })
    await render()
    expect(host.textContent).toContain('PS> npm test')
    expect(host.textContent).toContain('3 passing')
    expect(host.textContent).toContain('style.css')
    expect(host.textContent).toContain('−1 +1')
    expect(host.textContent).toContain('Add form')
    expect(host.querySelector('b')?.textContent).toBe('blue')
    expect(host.textContent).toContain('done · 1m 05s · $0.050 · 3 turns')
    // the final summary repeats the last reply, so it is shown once
    expect(host.textContent!.split('Made it').length - 1).toBe(1)
  })

  it('the Files tab shows the tree with changed files marked, and opens a file', async () => {
    claude.files.mockResolvedValue([
      { path: 'src', dir: true, size: 0, mtime: 1 },
      { path: 'src/app.js', dir: false, size: 20, mtime: 1 },
      { path: 'index.html', dir: false, size: 50, mtime: 1 }
    ])
    claude.read.mockResolvedValue({ kind: 'text', text: '<h1>Slop</h1>', size: 13, truncated: false })
    const out = [{ t: 1, kind: 'tool' as const, text: 'Write index.html', tool: 'Write', input: { file_path: 'index.html', content: '<h1>Slop</h1>' } }]
    useStore.setState({ claudeSessions: [session()], claudeSelected: 's1', claudeOutput: { s1: out } })
    await render()
    await click(button('Files'))
    expect(host.textContent).toContain('index.html')
    expect(host.textContent).toContain('A')
    await click(button('index.html'))
    expect(claude.read).toHaveBeenCalledWith('s1', 'index.html')
    expect(host.textContent).toContain('<h1>Slop</h1>')
    await click(button('VS Code'))
    expect(claude.open).toHaveBeenCalledWith('s1', 'index.html', 'code')
  })

  it('the Preview tab frames the page from the workspace in a sandbox', async () => {
    claude.files.mockResolvedValue([{ path: 'index.html', dir: false, size: 50, mtime: 1 }])
    useStore.setState({ claudeSessions: [session()], claudeSelected: 's1' })
    await render()
    await click(button('Preview'))
    const frame = host.querySelector('iframe')!
    expect(frame.getAttribute('src')).toMatch(/^ccws:\/\/s1\/index\.html\?v=/)
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-pointer-lock')
  })

  it('the session menu asks twice before a fresh start or removal', async () => {
    useStore.setState({ claudeSessions: [session()], claudeSelected: 's1' })
    await render()
    await click(host.querySelector('button[aria-label="More session actions"]') ?? undefined)
    await click(button('Remove session'))
    expect(claude.remove).not.toHaveBeenCalled()
    await click(button('Click again to remove'))
    expect(claude.remove).toHaveBeenCalledWith('s1')
    await click(host.querySelector('button[aria-label="More session actions"]') ?? undefined)
    await click(button('Fresh start'))
    await click(button('Click again to start fresh'))
    expect(claude.reset).toHaveBeenCalledWith('s1')
  })

  it('renames a session inline', async () => {
    useStore.setState({ claudeSessions: [session()], claudeSelected: 's1' })
    await render()
    await click(host.querySelector('button[title="Rename"]') ?? undefined)
    const input = host.querySelector('input[aria-label="Session name"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Slop site')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(claude.rename).toHaveBeenCalledWith('s1', 'Slop site')
  })

  it('removing the selected session moves the selection on', async () => {
    useStore.setState({ claudeSessions: [session(), session({ id: 's2', name: 'B' })], claudeSelected: 's1' })
    const { applyClaudeEvent } = await import('../state/claude')
    const next = applyClaudeEvent({ sessions: useStore.getState().claudeSessions, output: { s1: [] } }, { type: 'removed', id: 's1' })
    expect(next.sessions.map((x) => x.id)).toEqual(['s2'])
    expect(next.output.s1).toBeUndefined()
  })
})
