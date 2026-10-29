import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo, Settings } from '@shared/types'

vi.mock('../../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))
vi.mock('../../audio/voice', () => ({ toggleListening: vi.fn(), toggleMicMuted: vi.fn() }))
const settingsSet = vi.fn(async (p: object) => p)
;(globalThis as { window: { api?: unknown } }).window.api = { settings: { set: settingsSet }, claude: { list: vi.fn().mockResolvedValue([]) } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useStore } = await import('../../state/store')
const { InputBar } = await import('./InputBar')

const model = (provider: ModelInfo['provider'], id: string, label: string): ModelInfo => ({ id: `${provider}:${id}`, provider, providerLabel: provider, model: id, label })
const models = [model('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5'), model('openai', 'gpt-5-mini', 'GPT-5 mini')]

let root: Root
let host: HTMLDivElement
const render = async () => { await act(async () => { root.render(<InputBar />) }) }
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const click = async (el: Element | undefined) => { expect(el, 'element to click').toBeTruthy(); await act(async () => { (el as HTMLElement).click() }) }

beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({
    view: 'chat',
    models,
    settings: { modelId: 'anthropic:claude-haiku-4-5', mode: 'ask', styleId: 'short', projectId: 'global', claude: { enabled: false } } as unknown as Settings,
    keys: [{ provider: 'anthropic', set: false }, { provider: 'openai', set: true }]
  })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('InputBar model picker', () => {
  it('lists keyed models first, dims the rest with a hint, and routes a dimmed pick to Settings instead of selecting it', async () => {
    await render()
    await click(button('Claude Haiku 4.5'))
    const items = [...host.querySelectorAll('button')].filter((b) => b.textContent?.includes('GPT-5 mini') || b.textContent?.includes('Claude Haiku 4.5'))
    const menu = items.filter((b) => b.getAttribute('aria-disabled') !== null || b.textContent?.includes('openai'))
    expect(menu[0]?.textContent).toContain('GPT-5 mini')
    const locked = items.find((b) => b.getAttribute('aria-disabled') === 'true')
    expect(locked?.textContent).toContain('Claude Haiku 4.5')
    expect(locked?.textContent).toContain('add one in Settings')
    await click(locked)
    expect(settingsSet).not.toHaveBeenCalled()
    expect(useStore.getState().view).toBe('settings')
  })

  it('selects a keyed model normally', async () => {
    await render()
    await click(button('Claude Haiku 4.5'))
    const item = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('GPT-5 mini'))
    await click(item)
    expect(settingsSet).toHaveBeenCalledWith({ modelId: 'openai:gpt-5-mini' })
    expect(useStore.getState().view).toBe('chat')
  })
})
