import type { SpeechSettings } from '@shared/types'

/**
 * Sentence pacing for the voice engine in use. The chunker releases the first clause early (after
 * `firstMinWords` words) so speech starts sooner; with a quick engine that is pure gain, but with one that
 * takes a second per request the tiny first chunk is over before the next sentence's audio arrives and the
 * reply stutters. So the first chunk grows with the engine's measured request -> first audio time: enough
 * words to keep playing while the next request is in flight.
 */

/** Rough speaking rate used to size the first chunk. */
const WORDS_PER_SECOND = 2.5
/** Engines quicker than this keep the user's own setting. */
export const QUICK_ENGINE_MS = 500

export function firstChunkWords(speech: SpeechSettings, firstByteMs: number | undefined): number {
  const base = speech.firstMinWords
  if (base === 0 || firstByteMs === undefined || firstByteMs <= QUICK_ENGINE_MS) return base
  // cover the next request's latency plus a little slack, never past a normal sentence
  const needed = Math.ceil(((firstByteMs + 300) / 1000) * WORDS_PER_SECOND)
  return Math.min(15, Math.max(base, needed))
}

/** Exponential moving average of an engine's first-audio latency; the first sample is taken as is. */
export class LatencyEstimate {
  private readonly ms = new Map<string, number>()

  sample(engine: string, firstByteMs: number): void {
    const prev = this.ms.get(engine)
    this.ms.set(engine, prev === undefined ? firstByteMs : Math.round(prev * 0.6 + firstByteMs * 0.4))
  }

  get(engine: string): number | undefined {
    return this.ms.get(engine)
  }
}
