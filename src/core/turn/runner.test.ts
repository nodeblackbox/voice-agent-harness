import { describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import type { AudioChunk, ModelInfo } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { TurnRunner, type RunnerDeps } from './runner'
import { Speaker } from '../speech/speaker'
import { CONTINUATION, STEP_LIMIT_PHRASE } from '../speech/fillers'
import type { ModelFactory } from '../providers/factory'
import { GroqKeyPool } from '../providers/keys'
import { ModelCapacity } from '../providers/capacity'
import { findModel } from '../providers/models'

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined }
})

const textStream = (pieces: string[], tokens: [number, number] = [10, 5]): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(...tokens) }
]

const toolCallStream = (name: string, input: Record<string, unknown>): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-1', toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(7, 3) }
]

type StreamSpec = LanguageModelV4StreamPart[] | Error
const mockModel = (streams: StreamSpec[]): MockLanguageModelV4 => {
  let i = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const spec = streams[Math.min(i++, streams.length - 1)]!
      if (spec instanceof Error) throw spec
      return { stream: simulateReadableStream({ chunks: spec }) }
    }
  })
}

const info = (id: string): ModelInfo => findModel(id)!

function harness(models: Record<string, MockLanguageModelV4>, over: Partial<RunnerDeps> = {}) {
  const chunks: AudioChunk[] = []
  const controller = new AbortController()
  const factory = {
    create: (m: ModelInfo) => {
      const model = models[m.id]
      if (!model) throw new Error(`no mock for ${m.id}`)
      return { model, key: 'k' }
    },
    groqPool: { report: vi.fn(), pick: () => 'k', size: () => 1, nextFreeInMs: () => 0, hasUsable: () => true }
  } as unknown as ModelFactory
  const speaker = new Speaker(
    'turn',
    {
      engine: { name: 'edge', synth: async (req) => Buffer.from(req.text) },
      fallback: { name: 'system', synth: async () => null },
      voice: { engine: 'edge', voice: 'v', kokoroVoice: 'af_heart', rate: 0, pitch: 0 },
      emit: (c) => chunks.push(c),
      onDegraded: () => undefined,
      log: () => undefined
    },
    controller.signal
  )
  const deps: RunnerDeps = {
    factory,
    model: info('anthropic:claude-haiku-4-5'),
    fallbacks: [info('groq:openai/gpt-oss-20b')],
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    maxSteps: 4,
    format: 'plain',
    speaker,
    speech: DEFAULT_TUNING.speech,
    brain: { ...DEFAULT_TUNING.brain, retryBackoffMs: 0 },
    fillerEnabled: true,
    firstTokenTimeoutMs: 2000,
    stallTimeoutMs: 2000,
    toolStallTimeoutMs: 2000,
    onDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onCue: vi.fn(),
    onMetrics: vi.fn(),
    onNotice: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    ...over
  }
  return { deps, chunks, controller, speaker, run: async () => {
    const r = await new TurnRunner(deps).run(controller.signal)
    await speaker.finish()
    return r
  } }
}

describe('TurnRunner', () => {
  it('streams text into deltas, sentences and metrics', async () => {
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([textStream(['Hello ', 'there. ', 'Second one.'])]) })
    const r = await h.run()
    expect(r).toMatchObject({ text: 'Hello there. Second one.', aborted: false, modelUsed: 'anthropic:claude-haiku-4-5' })
    expect(h.chunks.filter((c) => c.text).map((c) => c.text)).toEqual(['Hello there.', 'Second one.'])
    expect(h.deps.onDelta).toHaveBeenCalledTimes(3)
    const metrics = vi.mocked(h.deps.onMetrics).mock.calls[0]![0]
    expect(metrics).toMatchObject({ inputTokens: 10, outputTokens: 5, steps: 1, model: 'anthropic:claude-haiku-4-5' })
    expect(metrics.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('runs a tool round, speaks a filler once, and reports input and output', async () => {
    const calc = tool({
      description: 'add',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b })
    })
    const h = harness(
      { 'anthropic:claude-haiku-4-5': mockModel([toolCallStream('calc', { a: 2, b: 3 }), textStream(['Five.'], [20, 2])]) },
      { tools: { calc } }
    )
    const r = await h.run()
    expect(r.text).toBe('Five.')
    expect(h.deps.onToolStart).toHaveBeenCalledWith('call-1', 'calc', { a: 2, b: 3 })
    expect(h.deps.onToolEnd).toHaveBeenCalledWith('call-1', 'calc', true, { sum: 5 })
    expect(h.deps.onCue).toHaveBeenNthCalledWith(1, true)
    expect(h.deps.onCue).toHaveBeenLastCalledWith(false)
    const spoken = h.chunks.filter((c) => c.text).map((c) => c.text)
    expect(spoken).toHaveLength(2)
    expect(spoken[1]).toBe('Five.')
    expect(vi.mocked(h.deps.onMetrics).mock.calls[0]![0]).toMatchObject({ inputTokens: 27, outputTokens: 5, steps: 2 })
  })

  it('reports a failing tool as an error and keeps going', async () => {
    const bad = tool({
      description: 'bad',
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('tool exploded')
      }
    })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([toolCallStream('bad', {}), textStream(['Sorry.'])]) }, { tools: { bad }, fillerEnabled: false })
    const r = await h.run()
    expect(r.text).toBe('Sorry.')
    expect(h.deps.onToolEnd).toHaveBeenCalledWith('call-1', 'bad', false, undefined, expect.stringContaining('tool exploded'))
  })

  it('retries a transient failure on the same model before falling back', async () => {
    const overloaded = Object.assign(new Error('Overloaded'), { statusCode: 529 })
    const primary = mockModel([overloaded, textStream(['Back.'])])
    const h = harness({ 'anthropic:claude-haiku-4-5': primary, 'groq:openai/gpt-oss-20b': mockModel([textStream(['Fallback.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Back.')
    expect(h.deps.onNotice).not.toHaveBeenCalled()
  })

  it('falls back to the second model when the primary keeps failing', async () => {
    const overloaded = Object.assign(new Error('Overloaded'), { statusCode: 529 })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([overloaded]), 'groq:openai/gpt-oss-20b': mockModel([textStream(['Fallback.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Fallback.')
    expect(r.modelUsed).toBe('groq:openai/gpt-oss-20b')
    expect(h.deps.onNotice).toHaveBeenCalledWith(expect.stringContaining("isn't responding"))
    expect(vi.mocked(h.deps.onMetrics).mock.calls[0]![0]).toMatchObject({ fallbackUsed: true })
  })

  it('does not retry a non-transient error on the same model, but still tries the backup', async () => {
    const malformed = Object.assign(new Error('bad request'), { statusCode: 400 })
    const primary = mockModel([malformed, textStream(['not again'])])
    const h = harness({ 'anthropic:claude-haiku-4-5': primary, 'groq:openai/gpt-oss-20b': mockModel([textStream(['Backup.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Backup.')
    expect(primary.doStreamCalls).toHaveLength(1)
  })

  it('reports every model that failed, in plain words, when none answers', async () => {
    const malformed = Object.assign(new Error('bad request'), { statusCode: 400 })
    const tooBig = Object.assign(new Error('Request too large for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Requested 8536'), { statusCode: 413 })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([malformed]), 'groq:openai/gpt-oss-20b': mockModel([tooBig]) })
    const r = await h.run()
    expect(r.text).toBe('')
    expect(r.error).toBe("Claude Haiku 4.5 failed (400: bad request); GPT-OSS 20B can't take a request this big")
  })

  it('skips straight to the fallback model on an invalid API key, without a wasted same-model retry', async () => {
    const forbidden = Object.assign(new Error('invalid x-api-key'), { statusCode: 401 })
    const primary = mockModel([forbidden, textStream(['should not be reached'])])
    const h = harness({ 'anthropic:claude-haiku-4-5': primary, 'groq:openai/gpt-oss-20b': mockModel([textStream(['Fallback.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Fallback.')
    expect(r.modelUsed).toBe('groq:openai/gpt-oss-20b')
    expect(primary.doStreamCalls).toHaveLength(1)
    expect(h.deps.onNotice).toHaveBeenCalledWith('Claude Haiku 4.5 rejected the API key, trying GPT-OSS 20B.')
  })

  it('rotates past a dead key in the Groq pool instead of failing the turn', async () => {
    const forbidden = (msg: string) => Object.assign(new Error(msg), { statusCode: 401 })
    const pool = new GroqKeyPool({ keysFor: () => ['dead', 'live'] })
    const models: Record<string, MockLanguageModelV4> = {
      'anthropic:claude-haiku-4-5': mockModel([forbidden('invalid x-api-key')]),
      'groq:openai/gpt-oss-20b': mockModel([forbidden('Invalid API Key'), textStream(['Groq here.'])])
    }
    const factory = { create: (m: ModelInfo) => ({ model: models[m.id]!, key: m.provider === 'groq' ? pool.pick()! : 'k' }), groqPool: pool } as unknown as ModelFactory
    const h = harness(models, { factory })
    const r = await h.run()
    expect(r.text).toBe('Groq here.')
    expect(r.modelUsed).toBe('groq:openai/gpt-oss-20b')
    expect(h.deps.onNotice).toHaveBeenCalledTimes(1)
  })

  it('returns aborted when the outer signal fires', async () => {
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([textStream(['a', 'b'])]) })
    h.controller.abort()
    const r = await h.run()
    expect(r.aborted).toBe(true)
  })

  it('speaks a lead-in per tool call but not more often than fillerMinGapMs', async () => {
    const calc = tool({ description: 'add', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => ({ sum: a + b }) })
    const streams = [toolCallStream('calc', { a: 1, b: 1 }), toolCallStream('calc', { a: 2, b: 2 }), textStream(['Done.'])]
    const gapped = harness({ 'anthropic:claude-haiku-4-5': mockModel(streams) }, { tools: { calc }, speech: { ...DEFAULT_TUNING.speech, fillerMinGapMs: 60_000 } })
    await gapped.run()
    expect(gapped.chunks.filter((c) => c.kind === 'filler')).toHaveLength(1)
    const eager = harness({ 'anthropic:claude-haiku-4-5': mockModel(streams) }, { tools: { calc }, speech: { ...DEFAULT_TUNING.speech, fillerMinGapMs: 0 } })
    await eager.run()
    expect(eager.chunks.filter((c) => c.kind === 'filler')).toHaveLength(2)
  })

  it('says a continuation filler when a tool stays quiet past fillerAfterMs', async () => {
    const slow = tool({
      description: 'slow',
      inputSchema: z.object({}),
      execute: () => new Promise((r) => setTimeout(() => r({ ok: true }), 1800))
    })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([toolCallStream('slow', {}), textStream(['Finally.'])]) }, { tools: { slow }, speech: { ...DEFAULT_TUNING.speech, fillerAfterMs: 100 } })
    await h.run()
    const fillers = h.chunks.filter((c) => c.kind === 'filler').map((c) => c.text)
    expect(fillers).toHaveLength(2)
    expect(CONTINUATION).toContain(fillers[1])
    expect(h.speaker.fillers).toBe(2)
  }, 10_000)

  it('says so out loud when the tool round cap is hit before the model said anything', async () => {
    const calc = tool({ description: 'add', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => ({ sum: a + b }) })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([toolCallStream('calc', { a: 1, b: 2 })]) }, { tools: { calc }, maxSteps: 2, fillerEnabled: false })
    const r = await h.run()
    expect(r.hitStepLimit).toBe(true)
    expect(r.text).toContain(STEP_LIMIT_PHRASE)
    expect(h.chunks.filter((c) => c.text).map((c) => c.text)).toEqual([STEP_LIMIT_PHRASE])
    expect(vi.mocked(h.deps.onMetrics).mock.calls[0]![0]).toMatchObject({ steps: 2, hitStepLimit: true })
  })

  it('stays quiet about the step cap when the model already answered', async () => {
    const calc = tool({ description: 'add', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => ({ sum: a + b }) })
    const streams = [
      [...textStream(['Let me look. ']).slice(0, -1), { type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'calc', input: JSON.stringify({ a: 1, b: 2 }) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' }, usage: usage(7, 3) }],
      toolCallStream('calc', { a: 2, b: 2 })
    ]
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel(streams) }, { tools: { calc }, maxSteps: 2, fillerEnabled: false })
    const r = await h.run()
    expect(r.hitStepLimit).toBe(true)
    expect(r.text).not.toContain(STEP_LIMIT_PHRASE)
  })

  it('strips a bracketed bookkeeping note the model echoes at the start of its reply', async () => {
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([textStream(['[interrupted by the ', 'user before saying anything]', ' Sure, go ahead.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Sure, go ahead.')
    expect(h.chunks.filter((c) => c.text).map((c) => c.text)).toEqual(['Sure, go ahead.'])
    expect(h.deps.trace).toHaveBeenCalledWith('turn.note_echo', expect.objectContaining({ note: '[interrupted by the user before saying anything]' }))
  })

  it('keeps text that merely starts with a bracket', async () => {
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([textStream(['[Sam] is ', 'the name you gave me.'])]) })
    const r = await h.run()
    expect(r.text).toBe('is the name you gave me.')
  })

  it('treats a stall before the first token as a timeout that triggers fallback', async () => {
    const silent = new MockLanguageModelV4({
      doStream: (opts) => new Promise((_resolve, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by client'))))
    })
    const h = harness({ 'anthropic:claude-haiku-4-5': silent, 'groq:openai/gpt-oss-20b': mockModel([textStream(['Late.'])]) }, { firstTokenTimeoutMs: 300 })
    const r = await h.run()
    expect(r.text).toBe('Late.')
    expect(silent.doStreamCalls).toHaveLength(1) // a slow model is still slow a second later: no same-model retry
    expect(h.deps.onNotice).toHaveBeenCalledWith("Claude Haiku 4.5 isn't responding, trying GPT-OSS 20B.")
  }, 10_000)

  it('keeps waiting while the model thinks silently past the first-token timeout', async () => {
    const thinking: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-end', id: 'r' },
      ...textStream(['Thought it through.']).slice(1)
    ]
    const slowThinker = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: thinking, initialDelayInMs: 0, chunkDelayInMs: 250 }) })
    })
    const h = harness({ 'anthropic:claude-haiku-4-5': slowThinker }, { firstTokenTimeoutMs: 400, stallTimeoutMs: 400 })
    const r = await h.run()
    expect(r.text).toBe('Thought it through.')
  }, 10_000)

  it('waits out a short rate limit on the same model', async () => {
    const limited = Object.assign(new Error('Rate limit reached. Please try again in 50ms.'), { statusCode: 429 })
    const primary = mockModel([limited, textStream(['After the wait.'])])
    const h = harness({ 'anthropic:claude-haiku-4-5': primary }, { fallbacks: [] })
    const r = await h.run()
    expect(r.text).toBe('After the wait.')
    expect(primary.doStreamCalls).toHaveLength(2)
  })

  it('skips a long rate limit straight away, and remembers it for the next turn', async () => {
    const limited = Object.assign(new Error('Rate limit reached for model on tokens per minute (TPM): Limit 8000, Used 5232, Requested 5845. Please try again in 23.0775s.'), { statusCode: 429 })
    const capacity = new ModelCapacity()
    const models = { 'anthropic:claude-haiku-4-5': mockModel([limited]), 'groq:openai/gpt-oss-20b': mockModel([textStream(['Groq.']), textStream(['Groq again.'])]) }
    const factory = { create: (m: ModelInfo) => ({ model: models[m.id as keyof typeof models], key: 'k' }), groqPool: { report: vi.fn(), pick: () => 'k', size: () => 1, nextFreeInMs: () => 0, hasUsable: () => true }, capacity } as unknown as ModelFactory
    const first = harness(models, { factory })
    expect((await first.run()).text).toBe('Groq.')
    expect(first.deps.onNotice).toHaveBeenCalledWith('Claude Haiku 4.5 is rate-limited for 23s, trying GPT-OSS 20B.')
    const second = harness(models, { factory })
    expect((await second.run()).text).toBe('Groq again.')
    expect(models['anthropic:claude-haiku-4-5'].doStreamCalls).toHaveLength(1) // not asked again while it is still limited
    expect(second.deps.onNotice).toHaveBeenCalledWith(expect.stringMatching(/^Claude Haiku 4\.5 is rate-limited for another \d+s, trying GPT-OSS 20B\.$/))
  })

  it("learns a model's size ceiling from a 413 and stops sending it requests that cannot fit", async () => {
    const tooBig = Object.assign(new Error('Request too large for model `openai/gpt-oss-20b` on tokens per minute (TPM): Limit 8000, Requested 8536, please reduce your message size'), { statusCode: 413 })
    const capacity = new ModelCapacity()
    const groq = mockModel([tooBig])
    const primary = mockModel([Object.assign(new Error('bad'), { statusCode: 400 })])
    const models = { 'anthropic:claude-haiku-4-5': primary, 'groq:openai/gpt-oss-20b': groq }
    const factory = { create: (m: ModelInfo) => ({ model: models[m.id as keyof typeof models], key: 'k' }), groqPool: { report: vi.fn(), pick: () => 'k', size: () => 1, nextFreeInMs: () => 0, hasUsable: () => true }, capacity } as unknown as ModelFactory
    const big = 'x'.repeat(40_000) // ~10k tokens
    await harness(models, { factory, system: big }).run()
    expect(capacity.ceiling('groq:openai/gpt-oss-20b')).toBe(8000)
    const r = await harness(models, { factory, system: big }).run()
    expect(groq.doStreamCalls).toHaveLength(1) // the second, equally big turn never went to Groq
    expect(r.error).toMatch(/GPT-OSS 20B can't take a request this big \(about \d+ tokens, its limit is 8000\)/)
  })

  it('marks the stable system part as a cache breakpoint and keeps the live part after it', async () => {
    const model = mockModel([textStream(['Cached.'])])
    const h = harness({ 'anthropic:claude-haiku-4-5': model }, { system: { stable: 'RULES', live: 'NOW: 10:00' } })
    await h.run()
    const prompt = model.doStreamCalls[0]!.prompt
    expect(prompt.slice(0, 2)).toEqual([
      { role: 'system', content: 'RULES', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      { role: 'system', content: 'NOW: 10:00' }
    ])
  })

  it('asks the newer Claude models for low effort, and leaves models without effort alone', async () => {
    const sonnet = mockModel([textStream(['Quick.'])])
    await harness({ 'anthropic:claude-sonnet-5': sonnet }, { model: info('anthropic:claude-sonnet-5') }).run()
    expect(sonnet.doStreamCalls[0]!.providerOptions).toEqual({ anthropic: { effort: 'low' } })
    const haiku = mockModel([textStream(['Quick.'])])
    await harness({ 'anthropic:claude-haiku-4-5': haiku }).run()
    expect(haiku.doStreamCalls[0]!.providerOptions?.anthropic).toBeUndefined()
  })
})
