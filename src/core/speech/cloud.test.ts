import { describe, expect, it, vi } from 'vitest'
import { ElevenLabsEngine, FishEngine, InworldEngine, UNRECOVERABLE, speedOf, type CloudTtsDeps } from './cloud'
import type { TtsRequest } from './tts'

const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4])

const stream = (parts: Array<Buffer | string>, init: ResponseInit = {}): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(typeof p === 'string' ? new TextEncoder().encode(p) : new Uint8Array(p))
        c.close()
      }
    }),
    { status: 200, ...init }
  )

const deps = (fetchImpl: typeof fetch, key = 'k-1'): CloudTtsDeps => ({ key: () => key, fetch: fetchImpl, timeoutMs: () => 2000 })
const req = (over: Partial<TtsRequest> = {}): TtsRequest => ({ text: 'Hello there.', voice: '', rate: 0, pitch: 0, ...over })
const signal = () => new AbortController().signal

describe('ElevenLabsEngine', () => {
  it('posts the sentence to the streaming endpoint with the key header, and reports first-byte latency', async () => {
    const calls: Array<[string, RequestInit]> = []
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init!])
      return stream([mp3.subarray(0, 4), mp3.subarray(4)])
    }) as unknown as typeof fetch
    const first = vi.fn()
    const out = await new ElevenLabsEngine(deps(f)).synth(req({ voice: 'abc', model: 'eleven_v3', rate: 0.2, onFirstByte: first }), signal())
    expect(out).toEqual(mp3)
    expect(calls[0]![0]).toBe('https://api.elevenlabs.io/v1/text-to-speech/abc/stream?output_format=mp3_44100_64')
    expect((calls[0]![1].headers as Record<string, string>)['xi-api-key']).toBe('k-1')
    expect(JSON.parse(calls[0]![1].body as string)).toEqual({ text: 'Hello there.', model_id: 'eleven_v3', voice_settings: { speed: 1.2 } })
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('fails fast without a key, and the message counts as unrecoverable', async () => {
    const f = vi.fn() as unknown as typeof fetch
    await expect(new ElevenLabsEngine(deps(f, '')).synth(req(), signal())).rejects.toThrow('no API key for ElevenLabs')
    expect(f).not.toHaveBeenCalled()
    expect(UNRECOVERABLE.test('no API key for ElevenLabs')).toBe(true)
    expect(UNRECOVERABLE.test('ElevenLabs 402: insufficient credit')).toBe(true)
    expect(UNRECOVERABLE.test('ElevenLabs 500: oops')).toBe(false)
  })

  it('turns an HTTP error into a short message with the status and the body', async () => {
    const f = (async () => new Response('{"detail":{"status":"voice_not_found"}}', { status: 404 })) as unknown as typeof fetch
    await expect(new ElevenLabsEngine(deps(f)).synth(req(), signal())).rejects.toThrow('ElevenLabs 404: voice_not_found')
    const g = (async () => new Response('{"status":402,"message":"Insufficient API credit for this model."}', { status: 402 })) as unknown as typeof fetch
    await expect(new FishEngine(deps(g)).synth(req(), signal())).rejects.toThrow('Fish Audio 402: Insufficient API credit for this model.')
  })

  it('only knows cues on the v3/v4 models', () => {
    const e = new ElevenLabsEngine(deps(vi.fn() as unknown as typeof fetch))
    expect(e.acceptsTags({ model: 'eleven_flash_v2_5' })).toBe(false)
    expect(e.acceptsTags({ model: 'eleven_v4_turbo' })).toBe(true)
  })

  it('lists the account’s voices (own clones first) and the models that can speak', async () => {
    const f = (async (url: string | URL | Request) =>
      String(url).includes('/v2/voices')
        ? Response.json({ voices: [{ voice_id: 'p1', name: 'Sarah', category: 'premade', labels: { gender: 'female' } }, { voice_id: 'c1', name: 'Me', category: 'cloned' }] })
        : Response.json([{ model_id: 'eleven_v3', name: 'Eleven v3', can_do_text_to_speech: true }, { model_id: 'eleven_sts', name: 'STS', can_do_text_to_speech: false }])) as unknown as typeof fetch
    const cat = await new ElevenLabsEngine(deps(f)).catalog()
    expect(cat.voices.map((v) => v.shortName)).toEqual(['c1', 'p1'])
    expect(cat.models.map((m) => m.id)).toEqual(['eleven_v3'])
    expect(cat.error).toBeUndefined()
  })

  it('falls back to the built-in lists when the listing fails', async () => {
    const f = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch
    const cat = await new ElevenLabsEngine(deps(f)).catalog()
    expect(cat.error).toMatch(/401/)
    expect(cat.models.length).toBeGreaterThan(0)
    expect(cat.voices.length).toBeGreaterThan(0)
  })
})

describe('FishEngine', () => {
  it('sends the model as a header and the voice as reference_id', async () => {
    let seen: RequestInit | undefined
    const f = (async (_u: unknown, init?: RequestInit) => {
      seen = init
      return stream([mp3])
    }) as unknown as typeof fetch
    await new FishEngine(deps(f)).synth(req({ voice: 'ref-9', model: 's1', rate: -0.2 }), signal())
    expect((seen!.headers as Record<string, string>).model).toBe('s1')
    expect((seen!.headers as Record<string, string>).authorization).toBe('Bearer k-1')
    expect(JSON.parse(seen!.body as string)).toMatchObject({ text: 'Hello there.', reference_id: 'ref-9', format: 'mp3', prosody: { speed: 0.8 } })
  })

  it('rejects an empty body as "no audio"', async () => {
    const f = (async () => stream([])) as unknown as typeof fetch
    await expect(new FishEngine(deps(f)).synth(req(), signal())).rejects.toThrow('Fish Audio returned no audio')
  })
})

describe('InworldEngine', () => {
  const line = (b64: string) => JSON.stringify({ result: { audioContent: b64 } }) + '\n'

  it('reassembles newline-delimited JSON chunks into one MP3 and reports the first one', async () => {
    const first = vi.fn()
    const a = mp3.subarray(0, 4).toString('base64')
    const b = mp3.subarray(4).toString('base64')
    // a chunk boundary in the middle of a line must not break parsing
    const f = (async () => stream([line(a).slice(0, 10), line(a).slice(10) + line(b).slice(0, 5), line(b).slice(5)])) as unknown as typeof fetch
    const out = await new InworldEngine(deps(f)).synth(req({ onFirstByte: first }), signal())
    expect(out).toEqual(mp3)
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('surfaces an error object that arrives mid-stream after a 200', async () => {
    const f = (async () => stream([JSON.stringify({ error: { code: 7, message: 'quota exceeded' } }) + '\n'])) as unknown as typeof fetch
    await expect(new InworldEngine(deps(f)).synth(req(), signal())).rejects.toThrow('Inworld 7: quota exceeded')
  })

  it('uses Basic auth with the portal key as given and the speaking rate from the slider', async () => {
    let seen: RequestInit | undefined
    const f = (async (_u: unknown, init?: RequestInit) => {
      seen = init
      return stream([line(mp3.toString('base64'))])
    }) as unknown as typeof fetch
    await new InworldEngine(deps(f, 'base64==')).synth(req({ voice: 'Hana', model: 'inworld-tts-2', rate: 0.5 }), signal())
    expect((seen!.headers as Record<string, string>).authorization).toBe('Basic base64==')
    expect(JSON.parse(seen!.body as string)).toMatchObject({ voiceId: 'Hana', modelId: 'inworld-tts-2', audioConfig: { audioEncoding: 'MP3', speakingRate: 1.5 } })
  })
})

describe('speedOf', () => {
  it('maps the rate offset onto the provider’s multiplier range', () => {
    expect(speedOf(0, 0.7, 1.2)).toBe(1)
    expect(speedOf(0.5, 0.7, 1.2)).toBe(1.2)
    expect(speedOf(-0.5, 0.7, 1.2)).toBe(0.7)
  })
})
