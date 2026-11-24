import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/types'

vi.mock('../../audio/playback', () => ({ playback: { subscribe: vi.fn(), setMuted: vi.fn(), setDuck: vi.fn(), configure: vi.fn(), setOutput: vi.fn(), cancel: vi.fn(), onSpeaking: vi.fn(), onChunk: vi.fn(), playing: false } }))
vi.mock('../../audio/cue', () => ({ cue: { start: vi.fn(), stop: vi.fn() } }))
vi.mock('../../audio/devices', () => ({ listDevices: vi.fn(), pickDefaults: vi.fn() }))

const preview = vi.fn(async () => undefined)
;(globalThis as { window: { api?: unknown } }).window.api = { speak: { preview } }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { useStore } = await import('../../state/store')
const { SlowVoiceBanner } = await import('./SlowVoiceBanner')
const { friendlyVoice } = await import('./ChatHeader')

const MULTI = 'en-US-AvaMultilingualNeural'
const PLAIN = 'en-US-AvaNeural'
const settings = (voice: string, engine = 'edge') => ({ voice: { engine, voice, kokoroVoice: 'af_heart', rate: 0, pitch: 0, cloud: {}, expressive: false, proxy: { url: '', edge: false, cloud: false, list: '' } } }) as unknown as Settings

let root: Root
let host: HTMLDivElement
const updateSettings = vi.fn(async (patch: Partial<Settings>) => useStore.setState({ settings: { ...useStore.getState().settings!, ...patch } }))
const show = async () => { await act(async () => { root.render(<SlowVoiceBanner />) }) }
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text) || b.getAttribute('aria-label')?.includes(text) || b.title.includes(text))

beforeEach(() => {
  preview.mockClear()
  updateSettings.mockClear()
  useStore.setState({ settings: settings(MULTI), updateSettings: updateSettings as never, slowVoice: { voice: MULTI, ms: 3890, twin: PLAIN, twinMs: 930 } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('SlowVoiceBanner', () => {
  it('says how slow the voice is and what the plain one measured', async () => {
    await show()
    expect(host.textContent).toContain('Ava Multilingual is taking about 3.9 s to start speaking')
    expect(host.textContent).toContain('Ava is the same speaker and just measured 0.9 s')
  })

  it('switches to the quick voice in one click, plays it, and goes away', async () => {
    await show()
    await act(async () => { button('Switch to Ava')!.click() })
    expect(updateSettings).toHaveBeenCalledWith({ voice: expect.objectContaining({ voice: PLAIN }) })
    expect(preview).toHaveBeenCalledWith(PLAIN, 'edge')
    expect(host.textContent).toBe('')
    expect(useStore.getState().slowVoice).toBeNull()
  })

  it('can be dismissed, and hides when the voice or engine is no longer the slow one', async () => {
    await show()
    await act(async () => { button('Keep this voice')!.click() })
    expect(host.textContent).toBe('')
    expect(updateSettings).not.toHaveBeenCalled()
    await act(async () => { useStore.setState({ settings: settings(PLAIN), slowVoice: { voice: MULTI, ms: 3890, twin: PLAIN, twinMs: 930 } }) })
    expect(host.textContent).toBe('')
    await act(async () => { useStore.setState({ settings: settings(MULTI, 'kokoro') }) })
    expect(host.textContent).toBe('')
  })

  it('points at Settings when the voice has no quicker twin', async () => {
    useStore.setState({ settings: settings('en-GB-SoniaNeural'), slowVoice: { voice: 'en-GB-SoniaNeural', ms: 4200 } })
    await show()
    expect(host.textContent).toContain('Sonia is taking about 4.2 s')
    expect(button('Open Settings')).toBeTruthy()
  })
})

describe('friendlyVoice', () => {
  it('keeps Multilingual in the name: it is a different, slower voice', () => {
    expect(friendlyVoice(MULTI)).toBe('Ava Multilingual')
    expect(friendlyVoice(PLAIN)).toBe('Ava')
    expect(friendlyVoice(undefined)).toBe('Ava')
  })
})
