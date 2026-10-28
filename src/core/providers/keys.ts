import type { Provider } from '@shared/types'

export interface KeySource {
  keysFor(provider: Provider): string[]
  // Extra request headers a provider needs (e.g. Anthropic keys not scoped to a workspace)
  headersFor?(provider: Provider): Record<string, string> | undefined
}

// Round-robin over several Groq keys; a 429 benches a key for as long as Groq asked (a minute if it didn't say), a 401 permanently.
export class GroqKeyPool {
  private idx = 0
  private benched = new Map<string, number>()

  constructor(private readonly source: KeySource) {}

  pick(): string | undefined {
    const keys = this.source.keysFor('groq')
    if (!keys.length) return undefined
    const now = Date.now()
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(this.idx + i) % keys.length]!
      const until = this.benched.get(key) ?? 0
      if (until > now) continue
      this.idx = (this.idx + i + 1) % keys.length
      return key
    }
    return keys[this.idx % keys.length]
  }

  size(): number {
    return this.source.keysFor('groq').length
  }

  hasUsable(): boolean {
    const now = Date.now()
    return this.source.keysFor('groq').some((k) => (this.benched.get(k) ?? 0) <= now)
  }

  /** Milliseconds until the soonest benched key is usable again (0 when one already is). */
  nextFreeInMs(): number {
    const now = Date.now()
    const keys = this.source.keysFor('groq')
    if (!keys.length) return Number.POSITIVE_INFINITY
    return Math.max(0, Math.min(...keys.map((k) => (this.benched.get(k) ?? 0) - now)))
  }

  report(key: string, status: number, waitMs = 60_000): void {
    if (status === 429) this.benched.set(key, Date.now() + waitMs)
    else if (status === 401 || status === 403) this.benched.set(key, Number.MAX_SAFE_INTEGER)
  }
}
