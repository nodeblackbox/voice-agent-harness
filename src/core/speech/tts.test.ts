import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const setMetadata = vi.fn(async () => {})
const constructed: unknown[] = []
/** How each toStream call answers, in call order: ms until its audio, or 'never'. */
const answers: Array<number | 'never'> = []
const streams: PassThrough[] = []
vi.mock('msedge-tts', () => ({
  MsEdgeTTS: class {
    constructor(opts?: { agent?: unknown }) {
      constructed.push(opts?.agent)
    }
    setMetadata = setMetadata
    close = vi.fn()
    toStream(text: string) {
      const audioStream = new PassThrough()
      const n = streams.push(audioStream)
      const after = answers.shift() ?? 0
      if (after !== 'never') setTimeout(() => !audioStream.destroyed && audioStream.end(Buffer.from(`#${n}:${text}`)), after)
      return { audioStream }
    }
  },
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
}))

import { EdgeTtsEngine, KokoroTtsEngine, edgeRate, edgeTtsStats, guardStreamPush, kokoroSpeed, type KokoroBackend } from './tts'

describe('KokoroTtsEngine', () => {
  const req = { text: 'Hello.', voice: 'en-US-AvaNeural', rate: 0, pitch: 0 }
  const backend = (over: Partial<KokoroBackend> = {}): KokoroBackend => ({
    ready: () => true,
    start: vi.fn(async () => true),
    synth: vi.fn(async () => Buffer.from('RIFF')),
    ...over
  })

  it('starts the backend and hands the sentence to the Windows voice while Kokoro is loading', async () => {
    const b = backend({ ready: () => false })
    const out = await new KokoroTtsEngine(b, () => 'af_heart').synth(req, new AbortController().signal)
    expect(out).toBeNull()
    expect(b.start).toHaveBeenCalled()
    expect(b.synth).not.toHaveBeenCalled()
  })

  it('returns Kokoro audio with its own voice once loaded', async () => {
    const b = backend()
    const out = await new KokoroTtsEngine(b, () => 'bf_emma').synth(req, new AbortController().signal)
    expect(out?.toString()).toBe('RIFF')
    expect(b.synth).toHaveBeenCalledWith('Hello.', 'bf_emma', 1, expect.anything())
  })

  it('speaks a Kokoro voice named in the request (a preview), but never an Edge name', async () => {
    const b = backend()
    await new KokoroTtsEngine(b, () => 'af_heart').synth({ ...req, voice: 'bf_isabella' }, new AbortController().signal)
    expect(b.synth).toHaveBeenLastCalledWith('Hello.', 'bf_isabella', 1, expect.anything())
    await new KokoroTtsEngine(b, () => 'af_heart').synth(req, new AbortController().signal)
    expect(b.synth).toHaveBeenLastCalledWith('Hello.', 'af_heart', 1, expect.anything())
  })

  it('falls through to the Windows voice instead of throwing when Kokoro keeps erroring', async () => {
    const b = backend({ synth: vi.fn(async () => Promise.reject(new Error('boom'))) })
    expect(await new KokoroTtsEngine(b, () => 'af_heart').synth(req, new AbortController().signal)).toBeNull()
    expect(b.synth).toHaveBeenCalledTimes(2)
  })

  it('retries one Kokoro hiccup so the sentence keeps the Kokoro voice', async () => {
    let n = 0
    const b = backend({ synth: vi.fn(async () => (n++ === 0 ? Promise.reject(new Error('reset')) : Buffer.from('wav'))) })
    expect(await new KokoroTtsEngine(b, () => 'af_heart').synth(req, new AbortController().signal)).toEqual(Buffer.from('wav'))
  })

  it('maps the rate offset onto a sane speed', () => {
    expect(kokoroSpeed(0)).toBe(1)
    expect(kokoroSpeed(0.2)).toBe(1.2)
    expect(kokoroSpeed(-0.3)).toBeCloseTo(0.7)
    expect(kokoroSpeed(5)).toBe(2)
  })
})

describe('edgeRate', () => {
  // a bare number in SSML is a multiplier: the +15% slider must not become rate="0.15"
  it('turns the rate offset into a signed SSML percentage', () => {
    expect(edgeRate(0)).toBe('+0%')
    expect(edgeRate(0.15)).toBe('+15%')
    expect(edgeRate(-0.3)).toBe('-30%')
  })
})

describe('guardStreamPush', () => {
  it('forwards frames for live streams and counts frames for missing or destroyed ones', () => {
    const original = vi.fn()
    const push = guardStreamPush(original, 'audio')
    const owner = { _streams: { live: { audio: {} }, dead: { audio: undefined } } as Record<string, Record<string, unknown> | undefined> }
    const before = edgeTtsStats.droppedFrames
    push.call(owner, 'frame', 'live')
    push.call(owner, 'frame', 'dead')
    push.call(owner, 'frame', 'never-registered')
    push.call({}, 'frame', 'live')
    expect(original).toHaveBeenCalledTimes(1)
    expect(original).toHaveBeenCalledWith('frame', 'live')
    expect(edgeTtsStats.droppedFrames - before).toBe(3)
  })
})

describe('EdgeTtsEngine.warm', () => {
  it('opens a socket for the voice, reuses the worker, and never throws', async () => {
    setMetadata.mockClear()
    const engine = new EdgeTtsEngine(1, 1000)
    await expect(engine.warm('en-US-AvaNeural')).resolves.toBe(true)
    await expect(engine.warm('en-US-AvaNeural')).resolves.toBe(true)
    expect(setMetadata).toHaveBeenCalledTimes(2)
    expect(setMetadata).toHaveBeenLastCalledWith('en-US-AvaNeural', 'mp3')
    setMetadata.mockRejectedValueOnce(new Error('offline'))
    await expect(engine.warm('en-US-AvaNeural')).resolves.toBe(false)
  })
})

describe('EdgeTtsEngine proxy', () => {
  it('opens its sockets through the agent given, and reopens when the agent changes', async () => {
    constructed.length = 0
    let agent: unknown = undefined
    const e = new EdgeTtsEngine(1, 1000, () => agent)
    await e.warm('en-US-AvaNeural')
    expect(constructed).toEqual([undefined])
    agent = { proxy: 'http://h:1' }
    await e.warm('en-US-AvaNeural')
    expect(constructed).toEqual([undefined, { proxy: 'http://h:1' }])
    await e.warm('en-US-AvaNeural')
    expect(constructed).toHaveLength(2)
  })
})

describe('EdgeTtsEngine racing', () => {
  const req = { text: 'Hi there.', voice: 'en-US-AvaNeural', rate: 0, pitch: 0 }

  it('sends the sentence twice and keeps the quicker answer, cancelling the other', async () => {
    streams.length = 0
    answers.splice(0, answers.length, 80, 5)
    const first = vi.fn()
    const e = new EdgeTtsEngine(3, 1000)
    const out = await e.synth({ ...req, race: 2, onFirstByte: first }, new AbortController().signal)
    expect(out.toString()).toBe('#2:Hi there.')
    expect(streams).toHaveLength(2)
    expect(streams[0]!.destroyed).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    // both sockets went back to the pool healthy: the next sentence reuses one
    constructed.length = 0
    answers.push(0)
    await e.synth(req, new AbortController().signal)
    expect(streams).toHaveLength(3)
    expect(constructed).toHaveLength(0)
  })

  it('one request without race, and never more copies than free sockets', async () => {
    streams.length = 0
    answers.length = 0
    const e = new EdgeTtsEngine(1, 1000)
    await e.synth(req, new AbortController().signal)
    expect(streams).toHaveLength(1)
    await e.synth({ ...req, race: 3 }, new AbortController().signal)
    expect(streams).toHaveLength(2)
  })

  it('survives one copy failing, and fails with the real reason when both do', async () => {
    streams.length = 0
    answers.splice(0, answers.length, 'never', 5)
    const e = new EdgeTtsEngine(2, 40)
    await expect(e.synth({ ...req, race: 2 }, new AbortController().signal)).resolves.toBeInstanceOf(Buffer)
    answers.splice(0, answers.length, 'never', 'never')
    await expect(e.synth({ ...req, race: 2 }, new AbortController().signal)).rejects.toThrow('Edge TTS timed out')
  })

  it('a barge-in cancels every copy', async () => {
    streams.length = 0
    answers.splice(0, answers.length, 'never', 'never')
    const c = new AbortController()
    const p = new EdgeTtsEngine(2, 1000).synth({ ...req, race: 2 }, c.signal)
    await new Promise((r) => setTimeout(r, 5))
    c.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(streams).toHaveLength(2)
    expect(streams.every((s) => s.destroyed)).toBe(true)
  })
})

describe('EdgeTtsEngine.warm with racing', () => {
  it('opens as many sockets as the first sentence will use', async () => {
    constructed.length = 0
    await new EdgeTtsEngine(4, 1000).warm('en-US-AvaNeural', 2)
    expect(constructed).toHaveLength(2)
  })
})
