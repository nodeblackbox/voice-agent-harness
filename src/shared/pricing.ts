/**
 * What a model call costs, so every reply can show its price next to its tokens. Prices are US dollars per
 * million tokens, list prices as of 2026-11 (Anthropic's first-party API). A model with no entry has no
 * known price: its cost is reported as unknown, never guessed.
 */

export interface Price {
  /** Input tokens that were not served from the cache. */
  in: number
  out: number
  /** Input tokens read from the prompt cache (default: a tenth of `in`). */
  cacheRead?: number
  /** Input tokens written to the prompt cache (default: 1.25 x `in`). */
  cacheWrite?: number
}

export const PRICES: Record<string, Price> = {
  'anthropic:claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'anthropic:claude-haiku-4-5': { in: 1, out: 5 },
  'anthropic:claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'anthropic:claude-sonnet-5': { in: 2, out: 10 },
  'anthropic:claude-sonnet-4-6': { in: 3, out: 15 },
  'anthropic:claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'anthropic:claude-opus-5': { in: 5, out: 25 },
  'anthropic:claude-opus-4-8': { in: 5, out: 25 }
}

/** Tokens of one model call (or several added up). `inputTokens` is the whole prompt, cached parts included. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Dollars for this usage on this model, or undefined when the model's price isn't known. */
export function costUsd(modelId: string | undefined, u: TokenUsage): number | undefined {
  const p = modelId ? PRICES[modelId] : undefined
  if (!p) return undefined
  const read = u.cacheReadTokens ?? 0
  const write = u.cacheWriteTokens ?? 0
  const fresh = Math.max(0, u.inputTokens - read - write)
  return (fresh * p.in + read * (p.cacheRead ?? p.in * 0.1) + write * (p.cacheWrite ?? p.in * 1.25) + u.outputTokens * p.out) / 1_000_000
}

/** "$0.0012", "$0.04", "$1.25": enough digits to tell small costs apart, no more. */
export function fmtUsd(n: number): string {
  if (n <= 0) return '$0'
  if (n < 0.0001) return '<$0.0001'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** 950 -> "950", 10236 -> "10.2k", 1250000 -> "1.25M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(2).replace(/0$/, '')}M`
}
