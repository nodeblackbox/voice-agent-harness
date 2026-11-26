/**
 * Adds up what the conversation has spent, from the same events the console shows: tokens and dollars per
 * reply (`turn.end` / `turn.cancel` metrics) and how much each tool put back into the prompt
 * (`turn.tool_end` result size). Pure, so the console can recompute it as entries arrive.
 */
import type { ConsoleEntry } from './console'

export interface ModelSpend {
  model: string
  turns: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** Undefined when this model has no known price. */
  costUsd?: number
}

export interface ToolSpend {
  name: string
  calls: number
  /** Rough tokens of results fed back to the model (4 characters a token). */
  resultTokens: number
}

export interface UsageSummary {
  /** Replies that reached a model. */
  turns: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  /** Dollars at list price for the replies whose model has a known price. */
  costUsd: number
  /** Replies on a model with no known price: their cost is not in `costUsd`. */
  unpricedTurns: number
  /** The most expensive prompt of the run. */
  biggestTurnTokens: number
  byModel: ModelSpend[]
  byTool: ToolSpend[]
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function summarizeUsage(entries: ConsoleEntry[]): UsageSummary {
  const out: UsageSummary = { turns: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, unpricedTurns: 0, biggestTurnTokens: 0, byModel: [], byTool: [] }
  const models = new Map<string, ModelSpend>()
  const tools = new Map<string, ToolSpend>()
  for (const e of entries) {
    if (e.kind !== 'trace') continue
    const d = e.data ?? {}
    if (e.name === 'turn.tool_end') {
      const name = String(d.name ?? 'tool')
      const t = tools.get(name) ?? { name, calls: 0, resultTokens: 0 }
      t.calls += 1
      t.resultTokens += Math.ceil(n(d.resultChars) / 4)
      tools.set(name, t)
      continue
    }
    if (e.name !== 'turn.end' && e.name !== 'turn.cancel') continue
    const m = (d.metrics ?? {}) as Record<string, unknown>
    const input = n(m.inputTokens)
    const output = n(m.outputTokens)
    if (!input && !output) continue // cancelled before any model call finished
    const model = String(m.model ?? 'unknown').replace(/^[a-z]+:/, '')
    const priced = typeof m.costUsd === 'number'
    out.turns += 1
    out.inputTokens += input
    out.cacheReadTokens += n(m.cacheReadTokens)
    out.cacheWriteTokens += n(m.cacheWriteTokens)
    out.outputTokens += output
    out.biggestTurnTokens = Math.max(out.biggestTurnTokens, input)
    if (priced) out.costUsd += n(m.costUsd)
    else out.unpricedTurns += 1
    const s = models.get(model) ?? { model, turns: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
    s.turns += 1
    s.inputTokens += input
    s.cacheReadTokens += n(m.cacheReadTokens)
    s.outputTokens += output
    if (priced) s.costUsd = (s.costUsd ?? 0) + n(m.costUsd)
    models.set(model, s)
  }
  out.byModel = [...models.values()].sort((a, b) => b.inputTokens - a.inputTokens)
  out.byTool = [...tools.values()].sort((a, b) => b.resultTokens - a.resultTokens || b.calls - a.calls)
  return out
}
