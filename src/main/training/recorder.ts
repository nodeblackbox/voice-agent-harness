import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseCoachText } from './coach'
import { encodeWav24, peakDbfs } from './wav'

// Training recording mode: keeps a few minutes of the raw (unprocessed, native-rate) mic in a ring
// buffer and, for every user turn the ears detect, writes that span as tNNNN.wav plus a tNNNN.json
// describing it. The agent's audio never passes through here; only its text, as context.

export const PRE_ROLL_MS = 300
export const POST_ROLL_MS = 500
export const ASR_WAIT_MS = 30_000
export const ROOMTONE_S = 10
/** Below this a spoken take is too quiet to be useful training audio; the user is told once per session. */
export const LOW_PEAK_DBFS = -30
const RING_S = 180
/** Extra wait after a take's end before cutting it, for frames still in flight from the renderer. */
const CUT_MARGIN_MS = 150

export interface TapInfo {
  sampleRate: number
  device: string
  /** What the browser reports for the raw track (echo cancellation etc. should all be false). */
  processing: Record<string, unknown>
}

export interface SpeechEnd {
  reason: string
  silenceMs: number
  speechMs?: number
  afterCut?: boolean
  segments?: number
}

export interface RecorderDeps {
  root: string
  appVersion: string
  roomtone: boolean
  log: (msg: string) => void
  notify?: (msg: string) => void
  now?: () => number
}

interface Take {
  id: string
  fromMs: number
  toMs: number
  speechStartMs: number
  speechEndMs: number
  agentPrompt: string | null
  barge: boolean
  reason: string
  segments: number
  retakeOf: string | null
  continues: string | null
  inherited: { category: string | null; delivery: string | null; target_text: string | null }
  audio?: { sampleRate: number; duration_s: number; peak_dbfs: number | null }
  asr?: string | null
  written: boolean
  asrTimer?: ReturnType<typeof setTimeout>
}

const iso = (ms: number): string => new Date(ms).toISOString()
const localDate = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class TrainingRecorder {
  private readonly now: () => number
  private tap: TapInfo | null = null
  private ring = new Float32Array(0)
  private total = 0
  private lastAt = 0
  private roomtoneFrom: number | null = null
  private roomtoneDone = false

  private sessionId: string | null = null
  private sessionDir: string | null = null
  private sessionStarted = 0
  private ready: Promise<void> | null = null
  private chain: Promise<void> = Promise.resolve()
  private takeN = 0
  private takesWritten = 0
  private warnedLow = false

  private agentText: string | null = null
  private agentSpokeSinceTake = true
  private cutPrerollMs = 0
  private last: Take | null = null
  private readonly awaitingAsr: Take[] = []
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? Date.now
  }

  get session(): string | null {
    return this.sessionId
  }

  get recording(): boolean {
    return this.tap !== null
  }

  /** The renderer opened the raw mic. The first call of an app run creates the session folder. */
  tapStarted(info: TapInfo): void {
    this.tap = info
    this.ring = new Float32Array(Math.round(info.sampleRate * RING_S))
    this.total = 0
    this.lastAt = this.now()
    if (!this.ready) this.ready = this.openSession()
    if (this.deps.roomtone && !this.roomtoneDone) {
      this.roomtoneFrom = 0
      this.deps.notify?.(`Recording ${ROOMTONE_S} s of room tone: stay quiet until it says done.`)
    }
    this.queue(() => this.writeSession())
  }

  tapStopped(): void {
    this.tap = null
    this.roomtoneFrom = null
  }

  /** One block of raw float samples, in arrival order. */
  pushFrame(samples: Float32Array): void {
    if (!this.tap || !samples.length) return
    const cap = this.ring.length
    const src = samples.length > cap ? samples.subarray(samples.length - cap) : samples
    const at = (this.total + samples.length - src.length) % cap
    const first = Math.min(src.length, cap - at)
    this.ring.set(src.subarray(0, first), at)
    if (first < src.length) this.ring.set(src.subarray(first), 0)
    this.total += samples.length
    this.lastAt = this.now()
    if (this.roomtoneFrom !== null && this.total - this.roomtoneFrom >= this.tap.sampleRate * ROOMTONE_S) {
      const tone = this.copy(this.roomtoneFrom, this.roomtoneFrom + this.tap.sampleRate * ROOMTONE_S)
      const rate = this.tap.sampleRate
      this.roomtoneFrom = null
      this.roomtoneDone = true
      this.queue(async () => {
        await writeFile(join(this.sessionDir!, 'roomtone.wav'), encodeWav24(tone, rate))
        await this.writeSession()
        this.deps.notify?.('Room tone saved. Start talking whenever you like.')
      })
    }
  }

  /** The agent finished (or was cut off in) a reply; its text is the prompt for the next take. */
  onAgentText(text: string): void {
    if (!text.trim()) return
    this.agentText = text.trim()
    this.agentSpokeSinceTake = true
  }

  /** A barge-in cut: the ears opened the utterance late by this much buffered speech. */
  onBargeIn(prerollMs: number | undefined): void {
    this.cutPrerollMs = prerollMs ?? 0
  }

  onSpeechEnd(info: SpeechEnd): void {
    if (!this.tap) return
    const t = this.now()
    const speechEndMs = t - info.silenceMs
    const speechStartMs = speechEndMs - (info.speechMs ?? 0) - (info.afterCut ? this.cutPrerollMs : 0)
    this.cutPrerollMs = 0
    const tags = this.agentText ? parseCoachText(this.agentText) : null
    const prev = this.last
    const retakeOf = tags?.retake && this.agentSpokeSinceTake && prev ? (prev.retakeOf ?? prev.id) : null
    const continues = !this.agentSpokeSinceTake && prev ? prev.id : null
    // a "Go again" carries the original line forward; a continuation keeps its turn's labels
    const carry = (retakeOf || continues) && prev ? prev.inherited : { category: null, delivery: null, target_text: null }
    const take: Take = {
      id: `t${String(++this.takeN).padStart(4, '0')}`,
      fromMs: speechStartMs - PRE_ROLL_MS,
      toMs: speechEndMs + POST_ROLL_MS,
      speechStartMs,
      speechEndMs,
      agentPrompt: this.agentText,
      barge: info.afterCut === true,
      reason: info.reason,
      segments: info.segments ?? 0,
      retakeOf,
      continues,
      inherited:
        tags && !continues
          ? { category: tags.category ?? carry.category, delivery: tags.delivery ?? carry.delivery, target_text: tags.target_text ?? carry.target_text }
          : carry,
      written: false
    }
    this.last = take
    this.agentSpokeSinceTake = false
    this.awaitingAsr.push(take)
    take.asrTimer = this.later(ASR_WAIT_MS, () => {
      const i = this.awaitingAsr.indexOf(take)
      if (i >= 0) this.awaitingAsr.splice(i, 1)
      if (take.asr === undefined) take.asr = null
      this.maybeWriteMeta(take)
    })
    this.later(Math.max(0, take.toMs - t) + CUT_MARGIN_MS, () => this.cut(take))
  }

  /** Finals arrive in speech_end order, one per take. */
  onFinal(text: string): void {
    const take = this.awaitingAsr.shift()
    if (!take) return
    if (take.asrTimer) clearTimeout(take.asrTimer)
    take.asr = text
    this.maybeWriteMeta(take)
  }

  /** The ears restarted: transcripts still owed for earlier takes will never come. */
  earsRestarted(): void {
    for (const take of this.awaitingAsr.splice(0)) {
      if (take.asrTimer) clearTimeout(take.asrTimer)
      take.asr = null
      this.maybeWriteMeta(take)
    }
  }

  /** Waits for queued writes; used at shutdown and by tests. */
  async flush(): Promise<void> {
    await this.ready
    await this.chain
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private cut(take: Take): void {
    if (!this.tap) {
      this.deps.log(`training: ${take.id} dropped (mic closed before it could be cut)`)
      return
    }
    const rate = this.tap.sampleRate
    const toIdx = Math.min(this.total, Math.round(this.total - ((this.lastAt - take.toMs) * rate) / 1000))
    const fromIdx = Math.max(0, this.total - this.ring.length, Math.round(this.total - ((this.lastAt - take.fromMs) * rate) / 1000))
    if (toIdx <= fromIdx) {
      this.deps.log(`training: ${take.id} has no audio in the buffer`)
      return
    }
    const audio = this.copy(fromIdx, toIdx)
    // the buffer may not reach back to the planned start (mic opened mid-turn): stamp what was kept
    take.fromMs = this.lastAt - ((this.total - fromIdx) * 1000) / rate
    take.audio = { sampleRate: rate, duration_s: Math.round((audio.length / rate) * 100) / 100, peak_dbfs: peakDbfs(audio) }
    this.queue(() => writeFile(join(this.sessionDir!, `${take.id}.wav`), encodeWav24(audio, rate), { flag: 'wx' }))
    this.maybeWriteMeta(take)
  }

  private maybeWriteMeta(take: Take): void {
    if (take.written || !take.audio || take.asr === undefined) return
    take.written = true
    const peak = take.audio.peak_dbfs
    if (take.asr && (peak === null || peak < LOW_PEAK_DBFS) && !this.warnedLow) {
      this.warnedLow = true
      this.deps.notify?.(`Your raw mic level is low (peak ${peak ?? '-inf'} dBFS; aim for -12 to -6). Turn up the mic's own gain knob; the recording has no auto-gain.`)
    }
    const meta = {
      take_id: take.id,
      session_id: this.sessionId,
      started_at: iso(take.fromMs),
      ended_at: iso(take.toMs),
      speech_started_at: iso(take.speechStartMs),
      speech_ended_at: iso(take.speechEndMs),
      agent_prompt: take.agentPrompt,
      target_text: take.inherited.target_text,
      category: take.inherited.category,
      delivery: take.inherited.delivery,
      asr_text: take.asr,
      barge_in: take.barge,
      retake_of: take.retakeOf,
      continues: take.continues,
      end_reason: take.reason,
      sample_rate: take.audio.sampleRate,
      duration_s: take.audio.duration_s,
      peak_dbfs: take.audio.peak_dbfs,
      pre_roll_ms: PRE_ROLL_MS,
      post_roll_ms: POST_ROLL_MS
    }
    this.queue(async () => {
      await writeFile(join(this.sessionDir!, `${take.id}.json`), JSON.stringify(meta, null, 2), { flag: 'wx' })
      this.takesWritten++
      await this.writeSession()
    })
  }

  private copy(from: number, to: number): Float32Array {
    const cap = this.ring.length
    const out = new Float32Array(to - from)
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(from + i) % cap]!
    return out
  }

  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
    return t
  }

  /** Disk work runs one item at a time, after the session folder exists, and never throws into the turn loop. */
  private queue(job: () => Promise<unknown>): void {
    const ready = this.ready ?? Promise.resolve()
    this.chain = this.chain
      .then(() => ready)
      .then(job)
      .then(
        () => undefined,
        (err: unknown) => this.deps.log(`training: write failed: ${err instanceof Error ? err.message : String(err)}`)
      )
  }

  private async openSession(): Promise<void> {
    this.sessionStarted = this.now()
    const date = localDate(this.sessionStarted)
    await mkdir(this.deps.root, { recursive: true })
    const taken = (await readdir(this.deps.root)).map((n) => new RegExp(`^${date}_s(\\d+)$`).exec(n)?.[1]).filter(Boolean).map(Number)
    for (let n = Math.max(0, ...taken) + 1; ; n++) {
      const id = `${date}_s${String(n).padStart(2, '0')}`
      try {
        await mkdir(join(this.deps.root, id))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw e
      }
      this.sessionId = id
      this.sessionDir = join(this.deps.root, id)
      this.deps.log(`training: recording to ${this.sessionDir}`)
      return
    }
  }

  private async writeSession(): Promise<void> {
    const session = {
      session_id: this.sessionId,
      started_at: iso(this.sessionStarted),
      updated_at: iso(this.now()),
      mic: this.tap?.device ?? null,
      sample_rate: this.tap?.sampleRate ?? null,
      processing: this.tap?.processing ?? null,
      format: 'wav, mono, 24-bit PCM',
      app_version: this.deps.appVersion,
      takes: this.takesWritten,
      roomtone: this.roomtoneDone,
      gain_note: null
    }
    await writeFile(join(this.sessionDir!, 'session.json'), JSON.stringify(session, null, 2))
  }
}
