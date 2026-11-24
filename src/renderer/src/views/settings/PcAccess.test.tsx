import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'

vi.mock('../../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))

const check = vi.fn(async (p: string) => (p.includes('missing') ? { ok: false as const, error: `There is no folder at ${p}.` } : { ok: true as const, path: p.trim() === 'd:' ? 'D:\\' : p.trim() }))
const pickFolder = vi.fn(async (): Promise<string | null> => 'C:\\Users\\sam\\Projects')
;(globalThis as { window: { api?: unknown } }).window.api = { explore: { check, pickFolder } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useStore } = await import('../../state/store')
const { PcAccess } = await import('./PcAccess')

const settings = (explore: Partial<Settings['explore']> = {}) => ({ agentName: 'Ava', explore: { enabled: true, agent: true, roots: ['D:\\Code\\app'], seeded: true, ...explore } }) as unknown as Settings

let root: Root
let host: HTMLDivElement
const updateSettings = vi.fn(async (patch: Partial<Settings>) => useStore.setState({ settings: { ...useStore.getState().settings!, ...patch } }))
const show = async () => { await act(async () => { root.render(<PcAccess />) }) }
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text) || b.getAttribute('aria-label')?.includes(text))!
const type = async (text: string) => {
  const input = host.querySelector('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const roots = () => [...host.querySelectorAll('li')].map((li) => li.textContent)
const saved = () => useStore.getState().settings!.explore

beforeEach(() => {
  check.mockClear()
  pickFolder.mockClear()
  updateSettings.mockClear()
  useStore.setState({ settings: settings(), updateSettings: updateSettings as never })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('PcAccess', () => {
  it('shows the approved folders and says access is read-only', async () => {
    await show()
    expect(roots()).toEqual(['D:\\Code\\app'])
    expect(host.textContent).toContain('Let Ava look at your files')
    expect(host.textContent).toContain('Nothing can be changed, moved, deleted or run')
  })

  it('adds a typed folder once the main process has checked it, tidied', async () => {
    await show()
    await type('d:')
    await act(async () => { button('Add').click() })
    expect(check).toHaveBeenCalledWith('d:')
    expect(saved().roots).toEqual(['D:\\Code\\app', 'D:\\'])
    expect(roots()).toEqual(['D:\\Code\\app', 'D:\\'])
    expect(host.querySelector('input')!.value).toBe('')
  })

  it('says why a folder was not added, and does not add one twice', async () => {
    await show()
    await type('D:\\missing')
    await act(async () => { button('Add').click() })
    expect(host.querySelector('[role=alert]')!.textContent).toBe('There is no folder at D:\\missing.')
    expect(updateSettings).not.toHaveBeenCalled()
    await type('d:\\code\\app\\')
    await act(async () => { button('Add').click() })
    expect(host.querySelector('[role=alert]')!.textContent).toContain('already on the list')
    expect(saved().roots).toEqual(['D:\\Code\\app'])
  })

  it('adds a folder from the picker and removes one', async () => {
    await show()
    await act(async () => { button('Browse').click() })
    expect(saved().roots).toEqual(['D:\\Code\\app', 'C:\\Users\\sam\\Projects'])
    await act(async () => { button('Remove D:\\Code\\app').click() })
    expect(saved().roots).toEqual(['C:\\Users\\sam\\Projects'])
  })

  it('warns when nothing is approved, and switches access and the helper', async () => {
    useStore.setState({ settings: settings({ roots: [] }) })
    await show()
    expect(host.textContent).toContain('No folders approved, so Ava cannot see any files yet.')
    const toggles = [...host.querySelectorAll('button[aria-pressed]')] as HTMLButtonElement[]
    expect(toggles).toHaveLength(2)
    await act(async () => { toggles[0]!.click() })
    expect(saved().enabled).toBe(false)
    await act(async () => { toggles[1]!.click() })
    expect(saved().agent).toBe(false)
  })
})
