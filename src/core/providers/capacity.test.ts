import { describe, expect, it } from 'vitest'
import { ModelCapacity, estimateTokens, isTooLarge, retryAfterMs, tokenLimit } from './capacity'

const groq429 = Object.assign(new Error('Rate limit reached for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Used 5232, Requested 5845. Please try again in 23.0775s.'), { statusCode: 429 })
const groq413 = Object.assign(new Error('Request too large for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Requested 8536, please reduce your message size and try again.'), { statusCode: 413 })

describe('capacity', () => {
  it('reads how long to wait from a retry-after header or the message', () => {
    expect(retryAfterMs(groq429)).toBe(23078)
    expect(retryAfterMs(new Error('Please try again in 1m2.5s'))).toBe(62500)
    expect(retryAfterMs(new Error('try again in 450ms'))).toBe(450)
    expect(retryAfterMs({ responseHeaders: { 'retry-after': '3' } })).toBe(3000)
    expect(retryAfterMs(new Error('overloaded'))).toBeUndefined()
  })

  it('reads a tokens-per-minute ceiling, and tells a too-large request from a busy one', () => {
    expect(tokenLimit(groq413)).toBe(8000)
    expect(isTooLarge(groq413)).toBe(true)
    expect(isTooLarge(groq429)).toBe(false)
    expect(tokenLimit(new Error('Limit 5 requests'))).toBeUndefined()
  })

  it('remembers a ceiling from a 413 and a busy window from a 429, until the model answers', () => {
    let now = 1000
    const c = new ModelCapacity(() => now)
    c.learn('g', groq413)
    expect(c.ceiling('g')).toBe(8000)
    expect(c.learn('a', groq429)).toBe(23078)
    expect(c.waitMs('a')).toBe(23078)
    now += 3078
    expect(c.waitMs('a')).toBe(20000)
    c.ok('a')
    expect(c.waitMs('a')).toBe(0)
    c.learn('k', groq429, false) // per-key limits: the model itself stays free
    expect(c.waitMs('k')).toBe(0)
  })

  it('estimates roughly four characters a token plus each tool schema', () => {
    expect(estimateTokens(4000, 0)).toBe(1000)
    expect(estimateTokens(4000, 10)).toBe(2200)
  })
})
