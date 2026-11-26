import type { Readable } from 'node:stream'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'
import type { TtsEngineId } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'

/** Frames msedge-tts delivered for a request whose stream was already destroyed (abort/timeout) or not yet registered. */
export const edgeTtsStats = { droppedFrames: 0 }

type StreamOwner = { _streams?: Record<string, Record<string, unknown> | undefined> }
type Push = (this: StreamOwner, data: unknown, requestId: string) => void

// msedge-tts shares one socket per client; with pooled workers a frame can arrive for a request
// whose stream we destroyed on abort/timeout, and the library then throws inside its socket
// handler and takes the process down. Guard the push and count what was dropped instead.
export function guardStreamPush(original: Push, field: 'audio' | 'metadata'): Push {
  return function (this: StreamOwner, data: unknown, requestId: string): void {
    const stream = this._streams?.[requestId]
    if (stream && stream[field]) original.call(this, data, requestId)
    else edgeTtsStats.droppedFrames++
  }
}

const proto = MsEdgeTTS.prototype as unknown as Record<string, Push | undefined>
if (proto._pushAudioData) proto._pushAudioData = guardStreamPush(proto._pushAudioData, 'audio')
if (proto._pushMetadata) proto._pushMetadata = guardStreamPush(proto._pushMetadata, 'metadata')

export interface TtsRequest {
  text: string
  /** The voice as this engine names it (see requestFields in @shared/tts). */
  voice: string
  /** Hosted engines: the model id; empty = the provider default. */
  model?: string
  /** Qwen: a delivery instruction sent with the sentence. */
  instruction?: string
  rate: number
  pitch: number
  /** Called once with request -> first audio byte latency, when the engine can measure it. */
  onFirstByte?: (ms: number) => void
  /**
   * Edge: send this many copies of the request at once and keep the first that answers (the rest are
   * cancelled). For the first sentence of a reply, where the wait is heard. Absent or 1 = one request.
   */
  race?: number
}

const WORDS = 'kettle window garden river morning coffee engine yellow market people music paper winter summer story answer simple early little gentle corner bridge letter number orange silver planet forest minute dinner travel basket pocket ticket candle mirror button carpet'.split(' ')

/**
 * A sentence nobody has asked Edge for before, about `chars` long. Microsoft answers a sentence it has
 * already synthesized from a cache in ~150 ms whatever the voice, so timing a fixed phrase measures the
 * network and nothing else; a speed test has to use new text.
 */
export function freshPhrase(chars = 45, random: () => number = Math.random): string {
  let s = `Number ${100 + Math.floor(random() * 900)},`
  while (s.length < chars - 7) s += ` ${WORDS[Math.floor(random() * WORDS.length)]}`
  return `${s}.`
}

// Returns MP3 bytes, or null when the renderer should speak the text itself (system voice).
export interface TtsEngine {
  readonly name: TtsEngineId
  synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer | null>
  /** True when inline delivery cues ("[laughs]") are understood for this request; absent = never (they are stripped). */
  acceptsTags?(req: Pick<TtsRequest, 'model'>): boolean
}

export class SystemTtsEngine implements TtsEngine {
  readonly name = 'system'
  async synth(): Promise<null> {
    return null
  }
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })
export const isAbort = (e: unknown): boolean => e instanceof Error && e.name === 'AbortError'

/** The local Kokoro process, owned by the main process. */
export interface KokoroBackend {
  ready(): boolean
  /** `force`: the user picked Kokoro, so skip any back-off after an earlier failed load. */
  start(opts?: { force?: boolean }): Promise<boolean>
  synth(text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer>
}

// `voice.rate` is a relative offset (-0.5..0.5, 0 = normal), as the Settings slider stores it.
// Edge wants it as a signed percentage: a bare number in SSML is a multiplier, so 0.15 would be 15% speed.
export const edgeRate = (rate: number): string => `${rate >= 0 ? '+' : ''}${Math.round(rate * 100)}%`
export const kokoroSpeed = (rate: number): number => Math.min(2, Math.max(0.5, 1 + rate))

// Last-resort local voice. Never throws for engine trouble: while Kokoro is loading or broken it
// returns null, which the renderer speaks with the Windows voice.
export class KokoroTtsEngine implements TtsEngine {
  readonly name = 'kokoro'

  constructor(
    private readonly backend: KokoroBackend,
    private readonly voice: () => string,
    private readonly log: (msg: string) => void = () => undefined
  ) {}

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer | null> {
    if (signal.aborted) throw abortError()
    if (!this.backend.ready()) {
      void this.backend.start()
      return null
    }
    const t0 = performance.now()
    // one retry: a single hiccup would otherwise put a sentence in the Windows voice mid-reply
    for (let attempt = 1; ; attempt++) {
      try {
        // the request's voice when it is a Kokoro one (a preview); otherwise (an Edge name, when Kokoro covers for Edge) the setting
        const voice = /^[a-z][fm]_[a-z]+$/.test(req.voice) ? req.voice : this.voice()
        const buf = await this.backend.synth(req.text, voice, kokoroSpeed(req.rate), signal)
        req.onFirstByte?.(performance.now() - t0)
        return buf
      } catch (e) {
        if (signal.aborted) throw abortError()
        this.log(`kokoro synth failed (attempt ${attempt}): ${(e as Error).message}`)
        if (attempt >= 2) return null
      }
    }
  }
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** An http(s) Agent for the Edge socket (a proxy), or undefined for a direct connection. */
export type AgentSource = () => unknown

class Worker {
  readonly tts: MsEdgeTTS
  voice = ''

  constructor(readonly agent: unknown) {
    this.tts = new MsEdgeTTS(agent ? { agent: agent as never } : undefined)
  }

  async ensure(voice: string): Promise<void> {
    if (this.voice === voice) return
    await this.tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    this.voice = voice
  }

  /** Reopen the socket if Edge closed it while idle; setMetadata is a no-op when it is still open. */
  async warm(voice: string): Promise<void> {
    await this.tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
    this.voice = voice
  }

  dispose(): void {
    try {
      this.tts.close()
    } catch {
      // already closed
    }
  }
}

// A small pool of Edge websocket clients so several sentences can synthesize concurrently
// while the model is still streaming, without opening a socket per sentence.
export class EdgeTtsEngine implements TtsEngine {
  readonly name = 'edge'
  private idle: Worker[] = []
  private count = 0
  private waiters: Array<(w: Worker) => void> = []

  constructor(
    private readonly max: number = DEFAULT_TUNING.speech.ttsPoolSize,
    private readonly timeoutMs: number | (() => number) = DEFAULT_TUNING.speech.ttsTimeoutMs,
    /** Proxy agent to open sockets with; read on every acquire so a settings change takes effect on the next sentence. */
    private readonly agent: AgentSource = () => undefined
  ) {}

  private get timeout(): number {
    return typeof this.timeoutMs === 'function' ? this.timeoutMs() : this.timeoutMs
  }

  private async acquire(): Promise<Worker> {
    let w = this.idle.pop()
    if (!w) {
      if (this.count < this.max) {
        this.count++
        return new Worker(this.agent())
      }
      w = await new Promise<Worker>((resolve) => this.waiters.push(resolve))
    }
    // the proxy setting changed since this socket was opened: reopen on the new route
    if (w.agent !== this.agent()) {
      w.dispose()
      w = new Worker(this.agent())
    }
    return w
  }

  private release(w: Worker, healthy: boolean): void {
    if (!healthy) {
      w.dispose()
      w = new Worker(this.agent())
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter(w)
    else this.idle.push(w)
  }

  /**
   * Pre-open one socket for `voice` so the first sentence of the coming reply skips the handshake.
   * Runs while the model is still thinking; never throws and never waits for a busy pool.
   */
  async warm(voice: string, sockets = 1): Promise<boolean> {
    const all = await Promise.all(Array.from({ length: Math.max(1, Math.min(sockets, this.max)) }, () => this.warmOne(voice)))
    return all[0]!
  }

  private async warmOne(voice: string): Promise<boolean> {
    if (this.idle.length === 0 && this.count >= this.max) return false
    const w = await this.acquire()
    let healthy = true
    try {
      await w.warm(voice)
      return true
    } catch {
      healthy = false
      return false
    } finally {
      this.release(w, healthy)
    }
  }

  /** A socket is free (or can be opened) without making anyone wait. */
  private spare(): boolean {
    return this.idle.length > 0 || this.count < this.max
  }

  /**
   * One sentence. With `req.race` > 1 the same request goes out on that many sockets and the first full
   * answer wins: Microsoft's time for one sentence swings widely between identical requests (measured
   * 2026-11-24 on plain Ava, 20 new sentences each: one request averaged 1.37 s with a worst of 2.2 s, three
   * copies 0.93 s with a worst of 1.45 s), and on a reply's first sentence that swing is silence the
   * listener sits through. Extra copies only take
   * sockets that are free, so racing never delays another sentence.
   */
  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
    const copies = Math.min(req.race ?? 1, this.max)
    if (copies <= 1) return this.one(req, signal)
    if (signal.aborted) throw abortError()
    const losers = new AbortController()
    const stop = (): void => losers.abort()
    signal.addEventListener('abort', stop, { once: true })
    let reported = false
    const mine: TtsRequest = {
      ...req,
      onFirstByte: (ms) => {
        if (reported) return
        reported = true
        req.onFirstByte?.(ms)
      }
    }
    const runs: Array<Promise<Buffer>> = [this.one(mine, losers.signal)]
    while (runs.length < copies && this.spare()) runs.push(this.one(mine, losers.signal))
    try {
      return await Promise.any(runs)
    } catch (e) {
      if (signal.aborted) throw abortError()
      // every copy failed: report the first one's reason, as a single request would
      throw e instanceof AggregateError ? (e.errors[0] as Error) : e
    } finally {
      signal.removeEventListener('abort', stop)
      losers.abort()
    }
  }

  private async one(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw abortError()
    const w = await this.acquire()
    let healthy = true
    try {
      await w.ensure(req.voice)
      const t0 = performance.now()
      return await new Promise<Buffer>((resolve, reject) => {
        let settled = false
        const chunks: Buffer[] = []
        let audioStream: Readable | null = null

        try {
          const result = w.tts.toStream(escapeXml(req.text), {
            rate: edgeRate(req.rate),
            pitch: `${req.pitch >= 0 ? '+' : ''}${Math.round(req.pitch)}Hz`
          })
          audioStream = result.audioStream
        } catch (e) {
          // Handle race condition or initialization errors in msedge-tts
          healthy = false
          reject(e instanceof Error ? e : new Error(String(e)))
          return
        }

        const finish = (err: Error | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          if (err) {
            // a barge-in abort leaves the socket fine: msedge-tts drops late frames for the destroyed
            // request by id, so keep the warm socket instead of paying a new handshake next turn
            if (!isAbort(err)) healthy = false
            audioStream?.destroy()
            reject(err)
            return
          }
          const buf = Buffer.concat(chunks)
          if (!buf.length) {
            healthy = false
            reject(new Error('Edge TTS returned no audio'))
          } else resolve(buf)
        }
        const onAbort = (): void => finish(abortError())
        const timer = setTimeout(() => finish(new Error('Edge TTS timed out')), this.timeout)
        signal.addEventListener('abort', onAbort, { once: true })
        audioStream.on('data', (d: Buffer) => {
          if (!chunks.length) req.onFirstByte?.(performance.now() - t0)
          chunks.push(d)
        })
        audioStream.on('error', (e: Error) => finish(e))
        audioStream.on('end', () => finish(null))
        audioStream.on('close', () => finish(null))
      })
    } catch (e) {
      if (!isAbort(e)) healthy = false
      throw e
    } finally {
      this.release(w, healthy)
    }
  }

  /** Close every idle socket; for a throwaway engine such as a proxy probe. */
  close(): void {
    for (const w of this.idle) w.dispose()
    this.idle = []
    this.count = 0
  }

  async listVoices(): Promise<Array<{ name: string; shortName: string; locale: string; gender: string }>> {
    const w = await this.acquire()
    try {
      const voices = await w.tts.getVoices()
      return voices.map((v) => ({ name: v.FriendlyName, shortName: v.ShortName, locale: v.Locale, gender: v.Gender }))
    } finally {
      this.release(w, true)
    }
  }
}
