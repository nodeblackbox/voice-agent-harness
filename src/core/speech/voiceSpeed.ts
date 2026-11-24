/**
 * How quickly an Edge voice answers, and what to offer when the chosen one is slow.
 *
 * Edge sends no audio until the whole sentence is synthesized, and how long that takes depends on the
 * voice far more than on the connection. Measured 2026-11-24 on new text (a repeated sentence comes from
 * Microsoft's cache in ~150 ms and proves nothing):
 *
 *   en-US-AvaMultilingualNeural   3.8 - 10 s      en-US-AvaNeural    0.8 - 1.6 s
 *   en-US-EmmaMultilingualNeural  1.2 - 4.2 s     en-US-EmmaNeural   0.5 - 1.0 s
 *   en-US-JennyNeural, AriaNeural 0.3 - 0.8 s
 *
 * The Multilingual voice was just as slow direct and through proxies in France, Germany, Italy, the US
 * and Japan, so no route fixes it. The plain voice of the same name is the same speaker and several
 * times quicker, so that is what gets offered.
 */
import { freshPhrase, type TtsEngine } from './tts'

/** The plain voice behind a Multilingual one ("en-US-AvaMultilingualNeural" -> "en-US-AvaNeural"), when Edge lists it. */
export function quickTwin(voice: string, known: readonly string[]): string | null {
  if (!voice.includes('Multilingual')) return null
  const twin = voice.replace('Multilingual', '')
  return known.includes(twin) ? twin : null
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

/** Median milliseconds until a new sentence's audio is ready in `voice`; throws when the engine fails. */
export async function voiceSpeed(engine: TtsEngine, voice: string, opts: { runs?: number; rate?: number; pitch?: number; timeoutMs?: number } = {}): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < (opts.runs ?? 3); i++) {
    const t0 = performance.now()
    await engine.synth({ text: freshPhrase(), voice, rate: opts.rate ?? 0, pitch: opts.pitch ?? 0 }, AbortSignal.timeout(opts.timeoutMs ?? 15_000))
    times.push(performance.now() - t0)
  }
  return Math.round(median(times))
}

/**
 * Watches the sentences actually spoken and says when the voice has been slow for long enough to be worth
 * a check: `min` sentences with a median over `slowMs`. Each voice is reported once per `againMs`.
 */
export class SlowVoiceWatch {
  private voice = ''
  private times: number[] = []
  private readonly reported = new Map<string, number>()

  constructor(private readonly opts: { slowMs?: number; min?: number; againMs?: number; now?: () => number } = {}) {}

  /** One spoken sentence's synthesis time. Returns the voice's median when it is slow and a check is due. */
  sample(voice: string, ms: number): number | null {
    if (voice !== this.voice) {
      this.voice = voice
      this.times = []
    }
    this.times.push(ms)
    if (this.times.length > 8) this.times.shift()
    if (this.times.length < (this.opts.min ?? 4)) return null
    const m = Math.round(median(this.times))
    if (m <= (this.opts.slowMs ?? 2000)) return null
    const now = this.opts.now?.() ?? Date.now()
    const last = this.reported.get(voice)
    if (last !== undefined && now - last < (this.opts.againMs ?? 6 * 3600_000)) return null
    this.reported.set(voice, now)
    return m
  }
}
