import { TTS_PROVIDERS, modelTakesTags } from '@shared/tts'
import type { CloudTtsProvider, TtsCatalog, TtsModelInfo, VoiceInfo } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { isAbort, type TtsEngine, type TtsRequest } from './tts'

/**
 * Hosted voices over HTTP: ElevenLabs, Fish Audio and Inworld. Each turns one sentence into an MP3 buffer, measures
 * request -> first audio byte, and lists its voices and models for the Settings picker. `fetch` is injected so the
 * main process can route it through a proxy and tests can fake it.
 */
export interface CloudTtsDeps {
  /** The API key, or '' when the user has none (the engine then fails fast and the Speaker falls back). */
  key: () => string
  fetch?: typeof fetch
  timeoutMs?: () => number
  log?: (msg: string) => void
}

/** Errors the Speaker should not retry: the key is missing or rejected, the account is out of credit, the voice is wrong. */
export const UNRECOVERABLE = /no api key|\b40[1-4]\b|\b402\b|insufficient|not found|unauthori[sz]ed|forbidden/i

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

/** Read a whole body, reporting the first chunk's arrival. */
async function drain(res: Response, onFirst: () => void): Promise<Buffer> {
  const chunks: Buffer[] = []
  if (!res.body) return Buffer.from(await res.arrayBuffer())
  const reader = res.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value?.length) {
      if (!chunks.length) onFirst()
      chunks.push(Buffer.from(value))
    }
  }
  return Buffer.concat(chunks)
}

/** "<label> <status>: <reason>" with the reason pulled out of a JSON error body when there is one. */
async function failure(label: string, res: Response): Promise<Error> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    // body unreadable
  }
  let reason = body.replace(/\s+/g, ' ').trim()
  try {
    const j = JSON.parse(body) as { detail?: { message?: string; status?: string } | string; message?: string; error?: { message?: string } | string }
    const d = typeof j.detail === 'string' ? j.detail : j.detail?.message ?? j.detail?.status
    const e = typeof j.error === 'string' ? j.error : j.error?.message
    reason = d ?? j.message ?? e ?? reason
  } catch {
    // not JSON
  }
  return new Error(`${label} ${res.status}: ${(reason || res.statusText).slice(0, 160)}`)
}

abstract class HttpTtsEngine implements TtsEngine {
  abstract readonly name: CloudTtsProvider
  protected readonly info
  constructor(protected readonly deps: CloudTtsDeps) {
    this.info = TTS_PROVIDERS[this.id()]
  }
  protected abstract id(): CloudTtsProvider
  protected get label(): string {
    return TTS_PROVIDERS[this.id()].label
  }
  protected get fetch(): typeof fetch {
    return this.deps.fetch ?? globalThis.fetch
  }
  protected get timeout(): number {
    return this.deps.timeoutMs?.() ?? DEFAULT_TUNING.speech.ttsTimeoutMs
  }
  protected key(): string {
    const k = this.deps.key().trim()
    if (!k) throw new Error(`no API key for ${this.label}`)
    return k
  }
  acceptsTags(req: Pick<TtsRequest, 'model'>): boolean {
    return modelTakesTags(this.id(), req.model ?? '')
  }

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw abortError()
    const key = this.key()
    const t0 = performance.now()
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.timeout)])
    let res: Response
    try {
      res = await this.request(req, key, combined)
    } catch (e) {
      if (signal.aborted) throw abortError()
      if (isAbort(e) || (e as Error).name === 'TimeoutError') throw new Error(`${this.label} timed out`)
      throw e
    }
    if (!res.ok) throw await failure(this.label, res)
    let buf: Buffer
    try {
      buf = await this.body(res, () => req.onFirstByte?.(performance.now() - t0), combined)
    } catch (e) {
      if (signal.aborted) throw abortError()
      if (isAbort(e) || (e as Error).name === 'TimeoutError') throw new Error(`${this.label} timed out`)
      throw e
    }
    if (!buf.length) throw new Error(`${this.label} returned no audio`)
    return buf
  }

  protected body(res: Response, onFirst: () => void, _signal: AbortSignal): Promise<Buffer> {
    return drain(res, onFirst)
  }

  protected abstract request(req: TtsRequest, key: string, signal: AbortSignal): Promise<Response>

  /** Voices and models for the picker; the built-in lists when the listing call fails. */
  async catalog(): Promise<TtsCatalog> {
    const base: TtsCatalog = { provider: this.id(), voices: this.info.voices, models: this.info.models }
    try {
      const live = await this.list(this.key())
      return { ...base, ...live }
    } catch (e) {
      return { ...base, error: (e as Error).message }
    }
  }

  protected abstract list(key: string): Promise<Partial<Pick<TtsCatalog, 'voices' | 'models'>>>
}

/** `voice.rate` is an offset (-0.5..0.5); the providers want a multiplier. */
export const speedOf = (rate: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round((1 + rate) * 100) / 100))

export class ElevenLabsEngine extends HttpTtsEngine {
  readonly name = 'elevenlabs' as const
  protected id(): CloudTtsProvider {
    return 'elevenlabs'
  }

  protected request(req: TtsRequest, key: string, signal: AbortSignal): Promise<Response> {
    const voice = encodeURIComponent(req.voice || this.info.defaultVoice)
    return this.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_64`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text: req.text, model_id: req.model || this.info.defaultModel, voice_settings: { speed: speedOf(req.rate, 0.7, 1.2) } }),
      signal
    })
  }

  protected async list(key: string): Promise<Partial<Pick<TtsCatalog, 'voices' | 'models'>>> {
    const H = { 'xi-api-key': key }
    const [vr, mr] = await Promise.all([this.fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: H }), this.fetch('https://api.elevenlabs.io/v1/models', { headers: H })])
    if (!vr.ok) throw await failure('ElevenLabs voices', vr)
    const vj = (await vr.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string> }> }
    const voices: VoiceInfo[] = (vj.voices ?? []).map((x) => ({
      shortName: x.voice_id,
      name: x.name,
      locale: x.labels?.accent ?? x.category ?? '',
      gender: x.labels?.gender ?? ''
    }))
    // own voices (cloned, generated, professional) first, then the stock ones
    const own = new Set(['cloned', 'generated', 'professional'])
    const rank = (id: string): number => (own.has(vj.voices?.find((x) => x.voice_id === id)?.category ?? '') ? 0 : 1)
    voices.sort((a, b) => rank(a.shortName) - rank(b.shortName))
    let models: TtsModelInfo[] | undefined
    if (mr.ok) {
      const mj = (await mr.json()) as Array<{ model_id: string; name: string; can_do_text_to_speech?: boolean }>
      const known = new Map(this.info.models.map((m) => [m.id, m]))
      models = mj.filter((m) => m.can_do_text_to_speech !== false).map((m) => known.get(m.model_id) ?? { id: m.model_id, label: m.name, tags: /_v[34]/.test(m.model_id) })
    }
    return { voices, models }
  }
}

export class FishEngine extends HttpTtsEngine {
  readonly name = 'fish' as const
  protected id(): CloudTtsProvider {
    return 'fish'
  }

  protected request(req: TtsRequest, key: string, signal: AbortSignal): Promise<Response> {
    return this.fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', model: req.model || this.info.defaultModel },
      body: JSON.stringify({
        text: req.text,
        reference_id: req.voice || this.info.defaultVoice,
        format: 'mp3',
        mp3_bitrate: 64,
        latency: 'balanced',
        normalize: true,
        prosody: { speed: speedOf(req.rate, 0.5, 2), volume: 0 }
      }),
      signal
    })
  }

  protected async list(key: string): Promise<Partial<Pick<TtsCatalog, 'voices' | 'models'>>> {
    const H = { authorization: `Bearer ${key}` }
    const [own, pop] = await Promise.all([
      this.fetch('https://api.fish.audio/model?self=true&page_size=50', { headers: H }),
      this.fetch('https://api.fish.audio/model?page_size=12&sort_by=task_count&language=en', { headers: H })
    ])
    if (!own.ok) throw await failure('Fish Audio voices', own)
    type Item = { _id: string; title: string; languages?: string[] }
    const mine = ((await own.json()) as { items?: Item[] }).items ?? []
    const popular = pop.ok ? (((await pop.json()) as { items?: Item[] }).items ?? []) : []
    const seen = new Set<string>()
    const voices: VoiceInfo[] = []
    for (const [list, tag] of [[mine, 'yours'], [popular, 'popular']] as const) {
      for (const m of list) {
        if (seen.has(m._id)) continue
        seen.add(m._id)
        voices.push({ shortName: m._id, name: m.title, locale: m.languages?.[0] ?? '', gender: tag })
      }
    }
    return { voices }
  }
}

export class InworldEngine extends HttpTtsEngine {
  readonly name = 'inworld' as const
  protected id(): CloudTtsProvider {
    return 'inworld'
  }

  protected request(req: TtsRequest, key: string, signal: AbortSignal): Promise<Response> {
    return this.fetch('https://api.inworld.ai/tts/v1/voice:stream', {
      method: 'POST',
      headers: { authorization: `Basic ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: req.text,
        voiceId: req.voice || this.info.defaultVoice,
        modelId: req.model || this.info.defaultModel,
        audioConfig: { audioEncoding: 'MP3', bitRate: 64000, sampleRateHertz: 24000, speakingRate: speedOf(req.rate, 0.5, 1.5) }
      }),
      signal
    })
  }

  // newline-delimited JSON: {"result":{"audioContent":"<base64>"}} per chunk, or {"error":{...}} mid-stream
  protected override async body(res: Response, onFirst: () => void): Promise<Buffer> {
    const parts: Buffer[] = []
    let rest = ''
    const take = (line: string): void => {
      const j = JSON.parse(line) as { result?: { audioContent?: string }; error?: { message?: string; code?: number } }
      if (j.error) throw new Error(`Inworld ${j.error.code ?? ''}: ${j.error.message ?? 'error'}`)
      if (j.result?.audioContent) {
        if (!parts.length) onFirst()
        parts.push(Buffer.from(j.result.audioContent, 'base64'))
      }
    }
    if (!res.body) return Buffer.from(await res.arrayBuffer())
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = rest.indexOf('\n')) >= 0) {
        const line = rest.slice(0, nl).trim()
        rest = rest.slice(nl + 1)
        if (line) take(line)
      }
    }
    rest += decoder.decode()
    if (rest.trim()) take(rest.trim())
    return Buffer.concat(parts)
  }

  protected async list(key: string): Promise<Partial<Pick<TtsCatalog, 'voices' | 'models'>>> {
    const filter = encodeURIComponent('lang_code = "en"')
    const r = await this.fetch(`https://api.inworld.ai/voices/v1/voices?pageSize=500&filter=${filter}`, { headers: { authorization: `Basic ${key}` } })
    if (!r.ok) throw await failure('Inworld voices', r)
    const j = (await r.json()) as { voices?: Array<{ voiceId: string; displayName?: string; gender?: string; languageCode?: string; source?: string }> }
    const voices: VoiceInfo[] = (j.voices ?? []).map((x) => ({ shortName: x.voiceId, name: x.displayName || x.voiceId, locale: x.languageCode ?? 'en', gender: x.gender ?? '' }))
    // the user's own clones first
    const rank = (id: string): number => ((j.voices?.find((x) => x.voiceId === id)?.source ?? 'SYSTEM') === 'SYSTEM' ? 1 : 0)
    voices.sort((a, b) => rank(a.shortName) - rank(b.shortName))
    return { voices }
  }
}
