/**
 * When Edge TTS fails (in practice: HTTP 429, Microsoft rate-limiting the free voice), the agent moves to
 * the local voice and STAYS there until a background probe, run between turns, shows Edge works again.
 * Before this, every turn retried Edge after a fixed minute, so the voice flipped between Ava, Kokoro and
 * the Windows voice from one reply (or sentence) to the next.
 *
 * Probes back off: 1 min, 2, 4 … for ordinary failures; 5 min, 10, 20 … for rate limiting; capped at 30 min.
 * Pure (clock injected) so the policy is unit-tested.
 */
const MINUTE = 60_000
const CAP_MS = 30 * MINUTE
const isRateLimit = (reason: string) => /\b429\b|too many requests|rate.?limit/i.test(reason)

export class EdgeHealth {
  private failures = 0
  private nextProbe = 0
  private probing = false

  constructor(private readonly now: () => number = Date.now) {}

  /** Edge is avoided until a probe succeeds. */
  get down(): boolean {
    return this.failures > 0
  }

  /** Record a failure (a degraded turn or a failed probe); returns the wait before the next probe. */
  fail(reason = ''): number {
    this.failures++
    const base = isRateLimit(reason) ? 5 * MINUTE : MINUTE
    const wait = Math.min(CAP_MS, base * 2 ** (this.failures - 1))
    this.nextProbe = this.now() + wait
    return wait
  }

  /** True when a background check of Edge is due (and none is running). */
  probeDue(): boolean {
    return this.down && !this.probing && this.now() >= this.nextProbe
  }

  /** Run one probe; true when Edge is back. */
  async probe(check: () => Promise<void>): Promise<{ ok: boolean; reason?: string; waitMs?: number }> {
    if (!this.probeDue()) return { ok: false }
    this.probing = true
    try {
      await check()
      this.failures = 0
      return { ok: true }
    } catch (e) {
      const reason = (e as Error).message
      return { ok: false, reason, waitMs: this.fail(reason) }
    } finally {
      this.probing = false
    }
  }
}
