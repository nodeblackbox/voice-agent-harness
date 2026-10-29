import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))
;(globalThis as { window: { api?: unknown } }).window.api = { settings: { set: vi.fn(async (p: object) => p) } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useStore } = await import('../../state/store')
const { NoKeyBanner } = await import('./NoKeyBanner')

let root: Root
let host: HTMLDivElement
const render = async () => { await act(async () => { root.render(<NoKeyBanner />) }) }

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({ view: 'chat', keys: [] })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('NoKeyBanner', () => {
  it('stays hidden until the key status has loaded, and when any provider has a key', async () => {
    await render()
    expect(host.textContent).toBe('')
    useStore.setState({ keys: [{ provider: 'anthropic', set: false }, { provider: 'groq', set: true }] })
    await render()
    expect(host.textContent).toBe('')
  })

  it('shows when no provider has a key, and its button opens Settings', async () => {
    useStore.setState({ keys: [{ provider: 'anthropic', set: false }, { provider: 'openai', set: false }] })
    await render()
    expect(host.textContent).toContain('No API key yet')
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Open Settings'))
    expect(btn).toBeTruthy()
    await act(async () => { btn!.click() })
    expect(useStore.getState().view).toBe('settings')
  })
})
