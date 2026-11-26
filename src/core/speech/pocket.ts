// Pocket TTS (Kyutai): a small text-to-speech model that runs on the CPU of this machine, served over HTTP by
// `pocket-tts serve` (POST /tts with a form: text, voice_url = a built-in voice name). It answers with a WAV that
// it streams as it generates; the header's sizes are placeholders because the length is not known up front, so
// they are written in here before the audio is played. Started on demand like Kokoro; Edge covers while it loads.

import type { TtsEngine, TtsRequest } from './tts'

export { POCKET_VOICES, POCKET_DEFAULT_VOICE } from '@shared/tts'
import { POCKET_VOICES } from '@shared/tts'

export interface PocketBackend {
  ready(): boolean
  /** `force`: the user picked it, so skip any back-off after an earlier failed start. */
  start(opts?: { force?: boolean }): Promise<boolean>
  /** WAV bytes for one sentence in `voice` (a built-in name, or a voice URL). */
  synth(text: string, voice: string, signal: AbortSignal): Promise<Buffer>
}

/**
 * A streamed WAV says its data is as long as it can be (0xFFFFFFFF), since the server writes the header before it
 * knows. Write the real RIFF and data sizes, so the player reads exactly the audio that is there.
 */
export function fixWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf
  const out = Buffer.from(buf)
  out.writeUInt32LE(out.length - 8, 4)
  // walk the chunks to the data chunk (usually at 36, but a LIST chunk may come first)
  let at = 12
  while (at + 8 <= out.length) {
    const id = out.toString('ascii', at, at + 4)
    const size = out.readUInt32LE(at + 4)
    if (id === 'data') {
      out.writeUInt32LE(out.length - (at + 8), at + 4)
      return out
    }
    at += 8 + size + (size % 2)
  }
  return out
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

export class PocketTtsEngine implements TtsEngine {
  readonly name = 'pocket'
  /**
   * One sentence at a time. The model runs on the CPU, so two sentences at once each take twice as long (measured:
   * 2.0-2.3 s each side by side against 1.0-1.3 s alone) and the first one, the wait the listener hears, comes late.
   */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly backend: PocketBackend,
    private readonly voice: () => string,
    private readonly log: (msg: string) => void = () => undefined
  ) {}

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer | null> {
    if (signal.aborted) throw abortError()
    if (!this.backend.ready()) {
      // still starting: this sentence goes to the cover voice, the server keeps loading
      void this.backend.start()
      return null
    }
    const t0 = performance.now()
    // the request's voice when it is a Pocket one (a preview); otherwise (an Edge name, when covering) the setting
    const voice = POCKET_VOICES.some((v) => v.id === req.voice) || /^(https?|hf):\/\//.test(req.voice) ? req.voice : this.voice()
    const mine = this.queue.then(() => this.run(req, voice, t0, signal))
    this.queue = mine.catch(() => undefined)
    return mine
  }

  private async run(req: TtsRequest, voice: string, t0: number, signal: AbortSignal): Promise<Buffer | null> {
    // a sentence of a reply that was cut off while it waited its turn: nothing to make
    if (signal.aborted) throw abortError()
    for (let attempt = 1; ; attempt++) {
      try {
        const wav = await this.backend.synth(req.text, voice, signal)
        req.onFirstByte?.(performance.now() - t0)
        return fixWavHeader(wav)
      } catch (e) {
        if (signal.aborted) throw abortError()
        this.log(`pocket synth failed (attempt ${attempt}): ${(e as Error).message}`)
        if (attempt >= 2) return null
      }
    }
  }
}
