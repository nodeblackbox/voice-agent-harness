import { describe, expect, it, vi } from 'vitest'

vi.mock('../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))
;(globalThis as { window: { api?: unknown } }).window.api = {}

const { useStore, selectHasAnyKey, keyedProviders } = await import('./store')

describe('key selectors', () => {
  it('are null until the key status has loaded, then say which providers have keys', () => {
    useStore.setState({ keys: [] })
    expect(selectHasAnyKey(useStore.getState())).toBeNull()
    expect(keyedProviders(useStore.getState().keys)).toBeNull()
    useStore.setState({ keys: [{ provider: 'anthropic', set: false }, { provider: 'groq', set: true }] })
    expect(selectHasAnyKey(useStore.getState())).toBe(true)
    expect([...keyedProviders(useStore.getState().keys)!]).toEqual(['groq'])
    useStore.setState({ keys: [{ provider: 'anthropic', set: false }] })
    expect(selectHasAnyKey(useStore.getState())).toBe(false)
    expect(keyedProviders(useStore.getState().keys)?.size).toBe(0)
  })
})
