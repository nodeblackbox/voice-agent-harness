import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: unknown) => handlers.set(ch, fn), on: (ch: string, fn: unknown) => handlers.set(ch, fn) }
}))

import { ASR_WAIT_MS, POST_ROLL_MS, PRE_ROLL_MS, ROOMTONE_S, TrainingRecorder } from './recorder'
import { setupTraining } from '.'

// 1 kHz keeps the arithmetic readable: one sample per millisecond
const RATE = 1000
let root: string
let clock: number

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  root = join(mkdtempSync(join(tmpdir(), 'va-training-')), 'raw')
  clock = 1_760_000_000_000
  handlers.clear()
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(join(root, '..'), { recursive: true, force: true })
})

const make = (over: { roomtone?: boolean } = {}) => {
  const notes: string[] = []
  const rec = new TrainingRecorder({ root, appVersion: '9.9.9', roomtone: over.roomtone ?? false, log: () => undefined, notify: (m) => notes.push(m), now: () => clock })
  rec.tapStarted({ sampleRate: RATE, device: 'Test Mic', processing: { echoCancellation: false } })
  /** `ms` of mic audio at a constant level, arriving in real time. */
  const mic = (ms: number, level: number): void => {
    for (let i = 0; i < ms; i += 20) {
      clock += 20
      rec.pushFrame(new Float32Array(20).fill(level))
    }
  }
  return { rec, mic, notes }
}

const session = (): string => join(root, readdirSync(root)[0]!)
const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(session(), file), 'utf8')) as Record<string, unknown>
const wavSamples = (file: string): number[] => {
  const b = readFileSync(join(session(), file))
  const out: number[] = []
  for (let o = 44; o < b.length; o += 3) out.push(Math.round((b.readIntLE(o, 3) / 0x7fffff) * 100) / 100)
  return out
}

/** The user speaks for `speechMs`, then the ears wait `silenceMs` and end the turn. */
const speak = (h: ReturnType<typeof make>, speechMs: number, level: number, silenceMs = 400, info: { afterCut?: boolean } = {}): void => {
  h.mic(speechMs, level)
  h.mic(silenceMs, 0.01)
  h.rec.onSpeechEnd({ reason: 'done', silenceMs, speechMs, ...info })
}

const settle = async (h: ReturnType<typeof make>, ms = POST_ROLL_MS + 500): Promise<void> => {
  h.mic(ms, 0.01)
  await vi.advanceTimersByTimeAsync(ms)
  await h.rec.flush()
}

describe('TrainingRecorder', () => {
  it('saves each turn as wav + json: the raw mic over the speech plus pre/post-roll, and nothing else', async () => {
    const h = make()
    h.mic(2000, 0.3) // the agent talking: the user's headphones keep it out, the mic hears the room
    h.rec.onAgentText('Guided line. Say this: "Can\'t be asked, I\'m having a bath." Then say it your own way.')
    speak(h, 1000, 0.5)
    await settle(h)
    h.rec.onFinal("Can't be asked, I'm having a bath.")
    await h.rec.flush()

    expect(readdirSync(session()).sort()).toEqual(['session.json', 't0001.json', 't0001.wav'])
    const samples = wavSamples('t0001.wav')
    expect(samples).toHaveLength(PRE_ROLL_MS + 1000 + POST_ROLL_MS)
    // exactly the mic's own samples for that window: room, speech, then the pause
    expect(samples.slice(0, PRE_ROLL_MS).every((v) => v === 0.3)).toBe(true)
    expect(samples.slice(PRE_ROLL_MS, PRE_ROLL_MS + 1000).every((v) => v === 0.5)).toBe(true)
    expect(samples.slice(PRE_ROLL_MS + 1000).every((v) => v === 0.01)).toBe(true)

    const meta = json('t0001.json')
    expect(meta).toMatchObject({
      take_id: 't0001',
      session_id: expect.stringMatching(/^\d{4}-\d{2}-\d{2}_s01$/),
      agent_prompt: expect.stringContaining('Say this'),
      category: 'guided',
      delivery: null,
      target_text: "Can't be asked, I'm having a bath.",
      asr_text: "Can't be asked, I'm having a bath.",
      barge_in: false,
      retake_of: null,
      continues: null,
      sample_rate: RATE,
      duration_s: 1.8,
      peak_dbfs: -6
    })
    expect(Date.parse(meta.ended_at as string) - Date.parse(meta.started_at as string)).toBe(1800)
    expect(json('session.json')).toMatchObject({ mic: 'Test Mic', sample_rate: RATE, app_version: '9.9.9', takes: 1, processing: { echoCancellation: false } })
  })

  it('links retakes and continuations, and writes the json without a transcript if it never comes', async () => {
    const h = make()
    h.rec.onAgentText('Emotion, surprised. Your mate says he got the job.')
    speak(h, 800, 0.4)
    await settle(h)
    h.rec.onFinal('wait what')
    h.rec.onAgentText('Go again. Emotion, surprised. Your mate says he got the job.')
    speak(h, 900, 0.4, 400, { afterCut: true })
    await settle(h)
    h.rec.onFinal('no way are you serious')
    // he keeps going after a pause; the agent did not reply in between
    speak(h, 700, 0.4)
    await settle(h, ASR_WAIT_MS + 1000)

    expect(json('t0001.json')).toMatchObject({ category: 'emotion_surprised', delivery: 'surprised', retake_of: null })
    expect(json('t0002.json')).toMatchObject({ retake_of: 't0001', barge_in: true, category: 'emotion_surprised', asr_text: 'no way are you serious' })
    expect(json('t0003.json')).toMatchObject({ continues: 't0002', category: 'emotion_surprised', asr_text: null })
  })

  it('never reuses a session folder or overwrites a take', async () => {
    const date = new Date(clock)
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    mkdirSync(join(root, `${day}_s01`), { recursive: true })
    const h = make()
    speak(h, 500, 0.2)
    await settle(h)
    h.rec.onFinal('hi')
    await h.rec.flush()
    expect(existsSync(join(root, `${day}_s02`, 't0001.wav'))).toBe(true)
    expect(readdirSync(join(root, `${day}_s01`))).toEqual([])
  })

  it('records room tone first when asked', async () => {
    const h = make({ roomtone: true })
    h.mic(ROOMTONE_S * 1000 + 100, 0.02)
    await h.rec.flush()
    expect(wavSamples('roomtone.wav')).toHaveLength(ROOMTONE_S * RATE)
    expect(h.notes.at(-1)).toMatch(/Room tone saved/)
  })

  it('warns once when spoken takes are too quiet to train on, and stamps only the audio it kept', async () => {
    const h = make()
    for (let i = 0; i < 2; i++) {
      speak(h, 600, 0.01)
      await settle(h)
      h.rec.onFinal('hello')
    }
    await h.rec.flush()
    expect(h.notes.filter((n) => /mic level is low/.test(n))).toHaveLength(1)
    // the first take wanted pre-roll from before the mic opened
    const meta = json('t0001.json')
    expect(Date.parse(meta.ended_at as string) - Date.parse(meta.started_at as string)).toBeCloseTo((meta.duration_s as number) * 1000, -1)
  })

  it('records nothing while the raw mic is closed', async () => {
    const h = make()
    h.rec.tapStopped()
    h.rec.onSpeechEnd({ reason: 'done', silenceMs: 400, speechMs: 1000 })
    await vi.advanceTimersByTimeAsync(ASR_WAIT_MS + 1000)
    await h.rec.flush()
    expect(readdirSync(session())).toEqual(['session.json'])
  })
})

describe('setupTraining', () => {
  it('is a no-op with the flag off: nothing returned, nothing written, the renderer told it is off', async () => {
    const t = setupTraining({ env: (k) => ({ RECORD_DIR: root })[k], appVersion: '1', log: () => undefined, notify: () => undefined })
    expect(t).toBeNull()
    expect([...handlers.keys()]).toEqual(['training:config'])
    expect(await (handlers.get('training:config') as () => unknown)()).toEqual({ enabled: false })
    expect(existsSync(root)).toBe(false)
  })

  it('with the flag on, uses the coach prompt file as the style', () => {
    const dir = join(root, '..')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'coach.md')
    writeFileSync(file, 'Be a coach for {user_name}.')
    const env: Record<string, string> = { RECORD_TRAINING_DATA: '1', RECORD_DIR: root, RECORD_SYSTEM_PROMPT_FILE: file }
    const t = setupTraining({ env: (k) => env[k], appVersion: '1', log: () => undefined, notify: () => undefined })!
    expect(t.styles[0]).toMatchObject({ id: 'recording-coach', body: 'Be a coach for {user_name}.' })
    expect(t.settings({ styleId: 'short' } as never)).toMatchObject({ styleId: 'recording-coach' })
    t.recorder.dispose()
  })
})
