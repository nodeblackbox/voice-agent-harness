import { describe, expect, it, vi } from 'vitest'
import { PocketTtsEngine, fixWavHeader, type PocketBackend } from './pocket'

/** A WAV as the server streams it: 24 kHz mono 16-bit, with the "unknown length" sizes in the header. */
function streamedWav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(0xffffffff, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(24000, 24)
  h.writeUInt32LE(48000, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(0xffffffff, 40)
  return Buffer.concat([h, data])
}

describe('fixWavHeader', () => {
  it('writes the real RIFF and data sizes into a streamed WAV', () => {
    const fixed = fixWavHeader(streamedWav(24000))
    expect(fixed.readUInt32LE(4)).toBe(fixed.length - 8)
    expect(fixed.readUInt32LE(40)).toBe(48000)
  })

  it('leaves anything that is not a WAV alone', () => {
    const mp3 = Buffer.from('ID3 not a wav at all, just some bytes here for the test', 'ascii')
    expect(fixWavHeader(mp3)).toBe(mp3)
  })
})

describe('PocketTtsEngine', () => {
  const backend = (over: Partial<PocketBackend> = {}): PocketBackend => ({ ready: () => true, start: vi.fn(async () => true), synth: vi.fn(async () => streamedWav(10)), ...over })
  const req = (voice: string) => ({ text: 'Hello there.', voice, rate: 0, pitch: 0 })

  it('speaks with the request voice when it is a Pocket one, else the setting, and fixes the header', async () => {
    const b = backend()
    const engine = new PocketTtsEngine(b, () => 'cosette')
    const out = await engine.synth(req('marius'), new AbortController().signal)
    expect(b.synth).toHaveBeenLastCalledWith('Hello there.', 'marius', expect.anything())
    expect(out!.readUInt32LE(40)).toBe(20)
    await engine.synth(req('en-US-AvaNeural'), new AbortController().signal)
    expect(b.synth).toHaveBeenLastCalledWith('Hello there.', 'cosette', expect.anything())
  })

  it('hands the sentence on (null) while the server is still starting, and starts it', async () => {
    const b = backend({ ready: () => false })
    expect(await new PocketTtsEngine(b, () => 'cosette').synth(req('cosette'), new AbortController().signal)).toBeNull()
    expect(b.start).toHaveBeenCalled()
  })

  it('makes one sentence at a time, in order, and drops the queued ones of a reply that was cut off', async () => {
    const order: string[] = []
    let release: () => void = () => undefined
    const synth = vi.fn(async (text: string) => {
      order.push(`start ${text}`)
      if (text === 'one') await new Promise<void>((r) => (release = r))
      order.push(`end ${text}`)
      return streamedWav(4)
    })
    const engine = new PocketTtsEngine(backend({ synth }), () => 'cosette')
    const cut = new AbortController()
    const a = engine.synth({ ...req('cosette'), text: 'one' }, new AbortController().signal)
    const b = engine.synth({ ...req('cosette'), text: 'two' }, cut.signal)
    const c = engine.synth({ ...req('cosette'), text: 'three' }, new AbortController().signal)
    await vi.waitFor(() => expect(order).toEqual(['start one']))
    cut.abort()
    release()
    await a
    await expect(b).rejects.toMatchObject({ name: 'AbortError' })
    await c
    expect(order).toEqual(['start one', 'end one', 'start three', 'end three'])
  })

  it('tries once more after a failure, then gives the sentence up', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new Error('reset')).mockResolvedValueOnce(streamedWav(10))
    expect(await new PocketTtsEngine(backend({ synth: flaky }), () => 'cosette').synth(req('cosette'), new AbortController().signal)).not.toBeNull()
    const broken = vi.fn(async () => Promise.reject(new Error('down')))
    expect(await new PocketTtsEngine(backend({ synth: broken }), () => 'cosette').synth(req('cosette'), new AbortController().signal)).toBeNull()
    expect(broken).toHaveBeenCalledTimes(2)
  })
})
