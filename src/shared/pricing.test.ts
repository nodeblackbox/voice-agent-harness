import { describe, expect, it } from 'vitest'
import { costUsd, fmtTokens, fmtUsd } from './pricing'

describe('costUsd', () => {
  it('prices fresh input, cache reads, cache writes and output separately', () => {
    // Haiku 5.5: $0.10 in, $0.50 out, reads a tenth, writes 1.25x
    const c = costUsd('anthropic:claude-haiku-5-5', { inputTokens: 10_000, cacheReadTokens: 8_000, cacheWriteTokens: 1_000, outputTokens: 200 })!
    expect(c).toBeCloseTo((1_000 * 0.1 + 8_000 * 0.01 + 1_000 * 0.125 + 200 * 0.5) / 1e6, 10)
  })
  it("uses a model's own cache-read price when it has one", () => {
    expect(costUsd('anthropic:claude-opus-5-5', { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.2, 10)
  })
  it('is unknown, not zero, for a model with no price', () => {
    expect(costUsd('groq:llama-3.3-70b-versatile', { inputTokens: 100, outputTokens: 100 })).toBeUndefined()
    expect(costUsd(undefined, { inputTokens: 100, outputTokens: 100 })).toBeUndefined()
  })
})

describe('formatting', () => {
  it('keeps small costs readable', () => {
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(0.00003)).toBe('<$0.0001')
    expect(fmtUsd(0.0012)).toBe('$0.0012')
    expect(fmtUsd(0.042)).toBe('$0.042')
    expect(fmtUsd(1.254)).toBe('$1.25')
  })
  it('shortens token counts', () => {
    expect(fmtTokens(950)).toBe('950')
    expect(fmtTokens(10_236)).toBe('10.2k')
    expect(fmtTokens(214_000)).toBe('214k')
    expect(fmtTokens(1_250_000)).toBe('1.25M')
  })
})
