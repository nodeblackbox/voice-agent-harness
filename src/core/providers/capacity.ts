// What providers have told us about their limits, remembered across turns: the biggest request a model will take
// (Groq's free tier refuses anything over its tokens-per-minute cap with a 413) and when a rate-limited model is free again.

const status = (e: unknown): number | undefined => (e as { statusCode?: number })?.statusCode
const message = (e: unknown): string => String((e as Error)?.message ?? e)

/** How long the provider asked us to wait, from a `retry-after` header or "try again in 23.07s" / "in 1m2s" / "in 450ms". */
export function retryAfterMs(e: unknown): number | undefined {
  const headers = (e as { responseHeaders?: Record<string, string> })?.responseHeaders
  const header = headers?.['retry-after'] ?? headers?.['Retry-After']
  if (header !== undefined && Number.isFinite(Number(header))) return Math.round(Number(header) * 1000)
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)\b/i.exec(message(e))
  if (!m) return undefined
  const minutes = Number(m[1] ?? 0)
  const n = Number(m[2])
  return Math.round(minutes * 60_000 + (m[3] === 'ms' ? n : n * 1000))
}

/** A tokens-per-minute ceiling stated in a 413/429 ("... tokens per minute (TPM): Limit 8000, ..."). */
export function tokenLimit(e: unknown): number | undefined {
  const msg = message(e)
  if (!/tokens per minute|TPM|request too large/i.test(msg)) return undefined
  const m = /Limit (\d+)/.exec(msg)
  return m ? Number(m[1]) : undefined
}

/** The request can never fit this model, whatever key or wait: retrying is pointless. */
export const isTooLarge = (e: unknown): boolean => status(e) === 413 || /request too large|reduce your message size/i.test(message(e))

export const isRateLimit = (e: unknown): boolean => status(e) === 429 || /rate limit/i.test(message(e))

/** Rough token count for a request: ~4 characters a token, plus a flat allowance per tool schema. */
export function estimateTokens(chars: number, tools: number): number {
  return Math.ceil(chars / 4) + tools * 120
}

export class ModelCapacity {
  private ceilings = new Map<string, number>()
  private busyUntil = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Read a failed call for limits; returns how long to wait before this model is worth trying again. */
  learn(modelId: string, e: unknown, trackBusy = true): number | undefined {
    const limit = tokenLimit(e)
    if (limit && isTooLarge(e)) this.ceilings.set(modelId, limit)
    if (!isRateLimit(e)) return undefined
    const wait = retryAfterMs(e) ?? 60_000
    if (trackBusy) this.busyUntil.set(modelId, this.now() + wait)
    return wait
  }

  /** The biggest request (tokens) this model accepted the last time it told us; undefined until it does. */
  ceiling(modelId: string): number | undefined {
    return this.ceilings.get(modelId)
  }

  /** Milliseconds until a rate-limited model is free again; 0 when it is. */
  waitMs(modelId: string): number {
    return Math.max(0, (this.busyUntil.get(modelId) ?? 0) - this.now())
  }

  /** It answered: whatever we remembered about it being busy is stale. */
  ok(modelId: string): void {
    this.busyUntil.delete(modelId)
  }
}
