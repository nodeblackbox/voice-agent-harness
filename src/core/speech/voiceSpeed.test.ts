import { describe, expect, it, vi } from 'vitest'
import { freshPhrase, type TtsEngine } from './tts'
import { SlowVoiceWatch, quickTwin, voiceSpeed } from './voiceSpeed'

describe('freshPhrase', () => {
  it('is new each time and about the length asked for', () => {
    const seen = new Set(Array.from({ length: 40 }, () => freshPhrase(45)))
    expect(seen.size).toBeGreaterThan(35)
    for (const s of seen) {
      expect(s.length).toBeGreaterThanOrEqual(30)
      expect(s.length).toBeLessThanOrEqual(50)
      expect(s).toMatch(/^Number \d{3}, .+\.$/)
    }
  })
})

describe('quickTwin', () => {
  const known = ['en-US-AvaNeural', 'en-US-AvaMultilingualNeural', 'fr-FR-VivienneMultilingualNeural']
  it('is the plain voice of the same name when Edge lists it', () => {
    expect(quickTwin('en-US-AvaMultilingualNeural', known)).toBe('en-US-AvaNeural')
    expect(quickTwin('en-US-AvaNeural', known)).toBeNull()
    expect(quickTwin('fr-FR-VivienneMultilingualNeural', known)).toBeNull()
  })
})

describe('voiceSpeed', () => {
  it('times new sentences in the voice asked for and returns the middle one', async () => {
    const texts: string[] = []
    const delays = [200, 5, 70]
    const engine: TtsEngine = {
      name: 'edge',
      synth: vi.fn(async (req) => {
        texts.push(`${req.voice}|${req.text}`)
        await new Promise((r) => setTimeout(r, delays[texts.length - 1]))
        return Buffer.from('x')
      })
    }
    const ms = await voiceSpeed(engine, 'en-US-AvaNeural', { runs: 3 })
    expect(new Set(texts).size).toBe(3)
    expect(texts.every((t) => t.startsWith('en-US-AvaNeural|Number '))).toBe(true)
    expect(ms).toBeGreaterThanOrEqual(50)
    expect(ms).toBeLessThan(190)
  })
})

describe('SlowVoiceWatch', () => {
  it('reports a voice once it has been slow for four sentences, and only once', () => {
    const w = new SlowVoiceWatch({ slowMs: 2000, min: 4 })
    expect(w.sample('multi', 4000)).toBeNull()
    expect(w.sample('multi', 3000)).toBeNull()
    expect(w.sample('multi', 5000)).toBeNull()
    expect(w.sample('multi', 3500)).toBe(4000)
    expect(w.sample('multi', 6000)).toBeNull()
  })

  it('stays quiet for a quick voice with one slow sentence among quick ones', () => {
    const w = new SlowVoiceWatch({ slowMs: 2000, min: 4 })
    for (const ms of [900, 1100, 6000, 800, 1000, 950]) expect(w.sample('plain', ms)).toBeNull()
  })

  it('starts again when the voice changes, and reports again after a long while', () => {
    let now = 0
    const w = new SlowVoiceWatch({ slowMs: 2000, min: 2, againMs: 1000, now: () => now })
    expect(w.sample('a', 3000)).toBeNull()
    expect(w.sample('b', 3000)).toBeNull()
    expect(w.sample('b', 3000)).toBe(3000)
    expect(w.sample('b', 3000)).toBeNull()
    now = 2000
    expect(w.sample('b', 3000)).toBe(3000)
  })
})
