import { describe, expect, it } from 'vitest'
import type { ConsoleEntry } from './console'
import { summarizeUsage } from './usage'

let id = 0
const ev = (name: string, data: Record<string, unknown>): ConsoleEntry => ({ id: ++id, t: id, kind: 'trace', level: 'info', name, msg: '', data })

describe('summarizeUsage', () => {
  it('adds up replies, split by model, and keeps unpriced replies out of the cost', () => {
    const s = summarizeUsage([
      ev('turn.end', { metrics: { model: 'anthropic:claude-haiku-5-5', inputTokens: 10_000, cacheReadTokens: 9_000, outputTokens: 50, costUsd: 0.0002 } }),
      ev('turn.end', { metrics: { model: 'anthropic:claude-haiku-5-5', inputTokens: 24_000, cacheReadTokens: 18_000, outputTokens: 150, costUsd: 0.0009 } }),
      ev('turn.cancel', { metrics: { model: 'groq:llama-3.3-70b-versatile', inputTokens: 5_000, outputTokens: 20 } }),
      ev('turn.cancel', { metrics: {} }) // cut off before the model answered: nothing spent
    ])
    expect(s.turns).toBe(3)
    expect(s.inputTokens).toBe(39_000)
    expect(s.cacheReadTokens).toBe(27_000)
    expect(s.outputTokens).toBe(220)
    expect(s.costUsd).toBeCloseTo(0.0011, 10)
    expect(s.unpricedTurns).toBe(1)
    expect(s.biggestTurnTokens).toBe(24_000)
    expect(s.byModel.map((m) => [m.model, m.turns, m.costUsd === undefined])).toEqual([
      ['claude-haiku-5-5', 2, false],
      ['llama-3.3-70b-versatile', 1, true]
    ])
  })

  it('ranks tools by how much they put back into the prompt', () => {
    const s = summarizeUsage([
      ev('turn.tool_end', { name: 'recall', ok: true, resultChars: 400 }),
      ev('turn.tool_end', { name: 'claude_details', ok: true, resultChars: 8_000 }),
      ev('turn.tool_end', { name: 'claude_details', ok: true, resultChars: 4_000 }),
      ev('turn.tool_end', { name: 'web_search', ok: false })
    ])
    expect(s.byTool).toEqual([
      { name: 'claude_details', calls: 2, resultTokens: 3_000 },
      { name: 'recall', calls: 1, resultTokens: 100 },
      { name: 'web_search', calls: 1, resultTokens: 0 }
    ])
  })
})
