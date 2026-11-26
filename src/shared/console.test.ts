import { describe as suite, expect, it } from 'vitest'
import { describe, rowText, type ConsoleEntry } from './console'

let id = 0
const ev = (name: string, data: Record<string, unknown> = {}): ConsoleEntry => ({ id: ++id, t: Date.UTC(2026, 10, 20, 7, 40, 30, 116), kind: 'trace', level: 'info', name, msg: '', data })
const line = (scope: string, msg: string, level: ConsoleEntry['level'] = 'info'): ConsoleEntry => ({ id: ++id, t: 0, kind: 'log', level, name: scope, msg })

suite('console rows', () => {
  it('says what was heard, and flags an empty transcript', () => {
    expect(describe(ev('ear.final', { text: 'Test again.', asrMs: 97 }))).toMatchObject({ cat: 'you', title: 'Heard: “Test again.”', detail: 'transcribed in 97 ms', tone: 'accent' })
    expect(describe(ev('ear.final', { text: '', asrMs: 137 }))).toMatchObject({ title: 'Heard nothing (empty transcript)', tone: 'warn' })
  })

  it('a turn start opens a new group with the model that will answer', () => {
    const r = describe(ev('turn.start', { via: 'voice', text: 'Yo, what is up?', model: 'openai:gpt-4.1-mini', mode: 'agent' }))
    expect(r).toMatchObject({ cat: 'turn', title: 'You said: “Yo, what is up?”', detail: 'gpt-4.1-mini · agent', turnStart: true })
  })

  it('explains a cut-off reply: why, what was said and what never was', () => {
    const r = describe(ev('turn.cancel', { reason: 'barge-in', spokenText: 'Hey hey!', unspokenText: 'What is on your mind?' }))
    expect(r.title).toBe('Reply cut off: you spoke over it')
    expect(r.detail).toBe('said “Hey hey!” · never said “What is on your mind?”')
    expect(r.tone).toBe('warn')
  })

  it('voice rows carry the engine and timings; a failed engine is a problem', () => {
    expect(describe(ev('tts.sentence', { seq: 1, kind: 'speech', chars: 58, ms: 185, firstByteMs: 185, attempts: 1, outcome: 'ok', engine: 'kokoro' }))).toMatchObject({ cat: 'voice', title: 'Voiced sentence 2', detail: 'kokoro · 58 chars · first audio 185 ms · total 185 ms' })
    expect(describe(ev('tts.sentence', { seq: 0, outcome: 'fallback', engine: 'kokoro', chars: 8, ms: 770, firstByteMs: 227 })).tone).toBe('warn')
    expect(describe(ev('tts.engine_down', { engine: 'elevenlabs', reason: 'ElevenLabs 404', fallback: 'kokoro', retryInMs: 60000 }))).toMatchObject({ tone: 'bad', title: 'elevenlabs voice is down: ElevenLabs 404', detail: 'using kokoro · retry in 60 s' })
  })

  it('model failures and fallbacks are problems', () => {
    expect(describe(ev('turn.attempt_failed', { model: 'anthropic:claude-haiku-5-5', error: '404: Workspace not found' }))).toMatchObject({ tone: 'bad', title: 'claude-haiku-5-5 failed: 404: Workspace not found' })
    expect(describe(ev('turn.attempt', { reason: 'fallback', model: 'openai:gpt-5-mini' })).tone).toBe('warn')
  })

  it('chatty events are marked noisy so they hide by default', () => {
    expect(describe(ev('ear.partial', { text: 'you are' })).noisy).toBe(true)
    expect(describe(ev('state', { from: 'idle', to: 'listening', event: 'mic_on' })).noisy).toBe(true)
    expect(describe(ev('turn.end', { interrupted: false, totalMs: 11345, chars: 73, chunks: 2, metrics: { model: 'openai:gpt-4.1-mini', inputTokens: 2760, outputTokens: 18 } }))).toMatchObject({ noisy: false, tone: 'good', detail: '11 s · 73 characters · 2 sentences · gpt-4.1-mini · 2.8k in / 18 out tokens' })
  })

  it('log lines keep their scope and level; categories follow the scope', () => {
    expect(describe(line('kokoro', 'ready on 57199'))).toMatchObject({ cat: 'voice', title: 'ready on 57199', detail: 'kokoro', tone: 'plain' })
    expect(describe(line('sidecar', 'exited code=1', 'error'))).toMatchObject({ cat: 'system', tone: 'bad' })
    expect(describe(line('renderer:capture', 'mic open'))).toMatchObject({ cat: 'you' })
  })

  it('an unknown event still reads: its name and simple fields', () => {
    expect(describe(ev('future.thing', { a: 1, nested: { x: 1 }, b: 'two' }))).toMatchObject({ cat: 'system', title: 'future.thing', detail: 'a=1  b=two' })
  })

  it('rowText is what search and copy use', () => {
    const e = ev('playback.drained', { chunks: 2 })
    expect(rowText(e)).toMatch(/^\d\d:\d\d:\d\d\.\d{3} playback\.drained All audio played \(2 sentences\)$/)
  })

  it('shows what a reply cost and what it was made of', () => {
    const t = (name: string, data: Record<string, unknown>) => describe({ id: 1, t: 0, kind: 'trace', level: 'info', name, msg: '', data })
    expect(t('turn.end', { totalMs: 6300, chars: 60, chunks: 2, metrics: { model: 'anthropic:claude-haiku-5-5', inputTokens: 24_000, cacheReadTokens: 18_000, outputTokens: 148, costUsd: 0.00086, steps: 2 } }).detail).toBe(
      '6.3 s · 60 characters · 2 sentences · claude-haiku-5-5 · 24k in (18k cached) / 148 out tokens · $0.0009 · 2 model calls'
    )
    const ctx = t('turn.context', { estimateTokens: 10_200, stableChars: 24_000, liveChars: 2_000, historyChars: 4_000, messages: 9, tools: 30 })
    expect(ctx.title).toBe('Sending about 10.2k tokens to the model')
    expect(ctx.detail).toBe("rules 6k · this turn's details and memory 500 · conversation 1k in 9 messages · 30 tools about 3.6k")
    expect(t('turn.tool_end', { name: 'claude_details', ok: true, ms: 12, detail: 'idle', resultChars: 8_000 }).detail).toBe('12 ms · idle · about 2k tokens of result')
    expect(t('turn.usage', { step: 1, model: 'anthropic:claude-haiku-5-5', inputTokens: 12_000, outputTokens: 40, finish: 'tool-calls' }).noisy).toBe(true)
  })

  it('explains playbook firings, hold-backs and broken files', () => {
    expect(describe(ev('trigger.fired', { id: 'long-message-breakdown', title: 'Break down long messages', why: 'when chars > 1200 (chars 1834)' }))).toMatchObject({ cat: 'turn', title: 'Playbook fired: Break down long messages', detail: 'when chars > 1200 (chars 1834)', tone: 'accent' })
    expect(describe(ev('trigger.dropped', { id: 'x', title: 'X', reason: 'cooldown' })).detail).toBe('still cooling down from its last firing')
    expect(describe(ev('playbooks.loaded', { count: 2, enabled: 1, invalid: 1 }))).toMatchObject({ title: 'Loaded 2 playbooks (1 on)', detail: '1 file could not be read', tone: 'warn' })
    expect(describe(ev('playbooks.changed', { id: 'push', action: 'off', by: 'ui' })).title).toBe('Playbook switched off: push')
    expect(describe(ev('playbooks.invalid', { id: 'broken', errors: ['line 4: unknown field "chance"', 'line 5: x'] }))).toMatchObject({ title: 'Playbook file not loaded: broken.md', detail: 'line 4: unknown field "chance" · 1 more problem', tone: 'bad' })
  })
})
