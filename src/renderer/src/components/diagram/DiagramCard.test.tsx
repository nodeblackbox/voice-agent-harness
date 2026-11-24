import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lineDiff, type DiagramDoc } from '@shared/diagram'

// Mermaid needs a real browser to lay out a diagram; here it only reports whether the code "compiles"
vi.mock('../../lib/mermaid', () => ({
  renderDiagram: vi.fn(async (code: string) => (code.includes('BROKEN') ? { ok: false, error: 'Parse error on line 2' } : { ok: true, svg: `<svg data-code="${code.length}"></svg>`, width: 300, height: 200 })),
  checkDiagram: vi.fn(async (code: string) => (code.includes('BROKEN') ? { ok: false, error: 'Parse error on line 2' } : { ok: true })),
  retheme: vi.fn()
}))
// the editor is CodeMirror; a textarea stands in for it
vi.mock('../../views/claude/CodeEditor', () => ({
  default: ({ value, onChange, readOnly }: { value: string; onChange?: (t: string) => void; readOnly?: boolean }) => <textarea aria-label="code" value={value} readOnly={readOnly} onChange={(e) => onChange?.(e.target.value)} />
}))
vi.mock('../../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))

const save = vi.fn()
;(globalThis as { window: { api?: unknown } }).window.api = { diagrams: { get: vi.fn(async () => null), save, create: vi.fn() } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useDiagrams } = await import('../../state/diagrams')
const { DiagramCard, InlineDiagram } = await import('./DiagramCard')
const { foldUnchanged } = await import('./DiffView')

const V1 = 'flowchart TD\n  A[Start] --> B[Boil the kettle]\n  B --> C[Drink]'
const V2 = V1.replace('Boil the kettle', 'Boil filtered water')

const doc = (): DiagramDoc => ({
  id: 'd1',
  title: 'Making tea',
  createdAt: 1,
  updatedAt: 2,
  versions: [
    { n: 1, code: V1, at: 1, by: 'agent' },
    { n: 2, code: V2, at: 2, by: 'agent', note: 'Filtered water' }
  ]
})

let root: Root
let host: HTMLDivElement
const render = async (node: ReactNode) => { await act(async () => { root.render(node) }) }
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text) || b.getAttribute('aria-label')?.includes(text)) as HTMLButtonElement | undefined
const click = async (el: Element | undefined) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }) }
const type = async (text: string) => {
  const el = host.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 60 && !ok(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  expect(ok()).toBe(true)
}

beforeEach(() => {
  save.mockReset()
  useDiagrams.setState({ docs: { d1: doc() }, drafts: {} })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('DiagramCard', () => {
  it('shows the picture for the version its chat step produced', async () => {
    await render(<DiagramCard id="d1" version={1} />)
    expect(host.textContent).toContain('Making tea')
    expect(host.textContent).toContain('v1 of 2')
    await until(() => !!host.querySelector('[data-testid="diagram-picture"]')?.innerHTML.includes(`data-code="${V1.length}"`))
    expect(host.textContent).toContain('An earlier version')
  })

  it('shows what changed from the version before in red and green', async () => {
    await render(<DiagramCard id="d1" version={2} />)
    expect(button('Changes')!.textContent).toContain('+1 −1')
    await click(button('Changes'))
    expect(host.textContent).toContain('Version 1 → 2')
    expect(host.textContent).toContain('Filtered water')
    expect(host.querySelector('[data-kind="removed"]')!.textContent).toContain('Boil the kettle')
    expect(host.querySelector('[data-kind="added"]')!.textContent).toContain('Boil filtered water')
  })

  it('saves an edit as a new version and moves to it', async () => {
    const V3 = V2 + '\n  C --> D[Wash up]'
    save.mockResolvedValue({ ...doc(), versions: [...doc().versions, { n: 3, code: V3, at: 3, by: 'user' }] })
    await render(<DiagramCard id="d1" version={2} />)
    await click(button('Code'))
    await until(() => !!host.querySelector('textarea'))
    await type(V3)
    expect(host.textContent).toContain('unsaved')
    await until(() => host.textContent!.includes('Compiles'))
    await click(button('Save'))
    expect(save).toHaveBeenCalledWith('d1', { code: V3, note: undefined })
    await until(() => host.textContent!.includes('v3 of 3'))
    expect(host.textContent).not.toContain('unsaved')
    expect(useDiagrams.getState().drafts.d1).toBeUndefined()
  })

  it('will not save code that does not compile', async () => {
    await render(<DiagramCard id="d1" version={2} />)
    await click(button('Code'))
    await until(() => !!host.querySelector('textarea'))
    await type('flowchart TD\n  BROKEN -->')
    await until(() => host.textContent!.includes('Parse error on line 2'))
    expect(button('Save')!.disabled).toBe(true)
    await click(button('Revert'))
    expect(host.textContent).not.toContain('unsaved')
  })

  it('brings an earlier version back as a new one, and keeps older versions read-only', async () => {
    save.mockResolvedValue({ ...doc(), versions: [...doc().versions, { n: 3, code: V1, at: 3, by: 'user' }] })
    await render(<DiagramCard id="d1" version={1} />)
    await click(button('Code'))
    await until(() => !!host.querySelector('textarea'))
    expect(host.querySelector('textarea')!.readOnly).toBe(true)
    await click(button('Bring this one back'))
    expect(save).toHaveBeenCalledWith('d1', { code: V1, note: 'Brought back version 1' })
  })

  it('steps between versions', async () => {
    await render(<DiagramCard id="d1" version={2} />)
    await click(button('Earlier version'))
    expect(host.textContent).toContain('v1 of 2')
    await click(button('Go to newest'))
    expect(host.textContent).toContain('v2 of 2')
  })

  it('says when a diagram is gone', async () => {
    useDiagrams.setState({ docs: { gone: null }, drafts: {} })
    await render(<DiagramCard id="gone" />)
    expect(host.textContent).toContain('no longer in the library')
  })
})

describe('InlineDiagram', () => {
  it('draws Mermaid found in text and shows its code on request', async () => {
    await render(<InlineDiagram code={V1} />)
    await until(() => !!host.querySelector('[data-testid="diagram-picture"]'))
    await click(button('Code'))
    expect(host.querySelector('pre')!.textContent).toContain('Boil the kettle')
  })
})

describe('diff folding', () => {
  it('folds long unchanged stretches and keeps context around a change', () => {
    const a = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    const b = [...a]
    b[15] = 'changed'
    const rows = foldUnchanged(lineDiff(a.join('\n'), b.join('\n')))
    expect(rows[0]).toEqual({ type: 'gap', from: 0, count: 13 })
    expect(rows.filter((r) => r.type === 'line')).toHaveLength(6)
    expect(rows.at(-1)).toEqual({ type: 'gap', from: 19, count: 12 })
  })
})
