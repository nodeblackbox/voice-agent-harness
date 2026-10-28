import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai'
import type { BrainSettings, ModelInfo, SpeechSettings, StyleFormat, TurnMetrics } from '@shared/types'
import { MissingKeyError, type ModelFactory } from '../providers/factory'
import { estimateTokens, isRateLimit, isTooLarge, retryAfterMs } from '../providers/capacity'
import { SentenceChunker } from '../speech/chunker'
import { SpeakableFilter } from '../prompts/speakable'
import type { Speaker } from '../speech/speaker'
import { STEP_LIMIT_PHRASE, continuationFiller, fillerFor } from '../speech/fillers'

export interface RunnerDeps {
  factory: ModelFactory
  model: ModelInfo
  /** Tried in order after the primary; duplicates and the primary itself are ignored. */
  fallbacks: ModelInfo[]
  /** A plain string, or stable + live parts so the stable part (and the tools before it) can be cached. */
  system: string | { stable: string; live: string }
  messages: ModelMessage[]
  tools: ToolSet
  maxSteps: number
  format: StyleFormat
  speaker: Speaker
  speech: SpeechSettings
  brain: BrainSettings
  fillerEnabled: boolean
  firstTokenTimeoutMs: number
  stallTimeoutMs: number
  toolStallTimeoutMs: number
  onDelta(text: string): void
  onToolStart(id: string, name: string, input: unknown): void
  onToolEnd(id: string, name: string, ok: boolean, output: unknown, error?: string): void
  onCue(on: boolean): void
  onMetrics(m: TurnMetrics): void
  onNotice(text: string): void
  log(msg: string): void
  trace?(ev: string, data?: Record<string, unknown>): void
}

export interface RunnerResult {
  text: string
  aborted: boolean
  error?: string
  modelUsed: string
  hitStepLimit?: boolean
}

const status = (e: unknown): number | undefined => (e as { statusCode?: number })?.statusCode
const isTransient = (e: unknown): boolean => {
  const s = status(e)
  if (s !== undefined) return [408, 409, 429, 500, 502, 503, 504, 529].includes(s)
  const msg = String((e as Error)?.message ?? e).toLowerCase()
  return /timeout|timed out|econnreset|fetch failed|network|socket|overloaded|stall/.test(msg)
}
// a bad or revoked key for the provider itself, not a transient outage: retrying the same model is pointless, go straight to fallback
const isAuthError = (e: unknown): boolean => {
  const s = status(e)
  if (s === 401 || s === 403) return true
  const msg = String((e as Error)?.message ?? e).toLowerCase()
  return /invalid x-api-key|invalid api key|authentication_error|unauthorized/.test(msg)
}
const describe = (e: unknown): string => {
  if (e instanceof MissingKeyError) return e.message
  const s = status(e)
  const msg = String((e as Error)?.message ?? e).split('\n')[0] ?? 'unknown error'
  return s ? `${s}: ${msg}` : msg
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

/** Why a model in the chain didn't answer, in words fit for a toast and the "I couldn't get a reply" line. */
type Miss = { model: ModelInfo; why: string }

type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

const isFirstTokenTimeout = (e: unknown): boolean => /^timeout: no response/.test(String((e as Error)?.message ?? ''))

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`

function missReason(e: unknown, info: ModelInfo): string {
  if (e instanceof MissingKeyError) return `has no API key (add one for ${info.providerLabel})`
  if (isAuthError(e)) return `rejected the API key`
  if (isTooLarge(e)) return `can't take a request this big`
  if (isRateLimit(e)) {
    const wait = retryAfterMs(e)
    return wait ? `is rate-limited for ${seconds(wait)}` : 'is rate-limited'
  }
  if (isFirstTokenTimeout(e)) return "isn't responding"
  const s = status(e)
  if (s && s >= 500) return `isn't responding (${describe(e)})`
  return `failed (${describe(e)})`
}

/** Waits shorter than this are worth sitting through (the turn is still young); longer ones skip to the next model. */
const MAX_RATE_WAIT_MS = 2500

export class TurnRunner {
  private text = ''
  private startedAt = performance.now()
  private metrics: TurnMetrics = {}
  private lastFillerAt = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: RunnerDeps) {}

  /**
   * The primary model, then each backup in order. A model is skipped up front when it already told us the request
   * is too big for it, or that it is rate-limited for longer than a short wait. A model that says nothing before
   * the first-token timeout is not retried (slow now means slow a second later); an overloaded or dropped
   * connection gets one same-model retry; a dead Groq key or a rate-limited one rotates to the next key.
   */
  async run(signal: AbortSignal): Promise<RunnerResult> {
    const chain = [this.deps.model, ...this.deps.fallbacks.filter((m, i, all) => m.id !== this.deps.model.id && all.findIndex((x) => x.id === m.id) === i)]
    const capacity = this.deps.factory.capacity
    const pool = this.deps.factory.groqPool
    const estimate = estimateTokens(this.requestChars(), Object.keys(this.deps.tools).length)
    const misses: Miss[] = []
    let lastError: unknown

    for (let k = 0; k < chain.length; k++) {
      const info = chain[k]!
      if (signal.aborted) return { text: this.text, aborted: true, modelUsed: info.id }

      const ceiling = capacity?.ceiling(info.id)
      if (ceiling && estimate > ceiling) {
        misses.push({ model: info, why: `can't take a request this big (about ${estimate} tokens, its limit is ${ceiling})` })
        this.deps.trace?.('turn.model_skipped', { model: info.id, reason: 'too_large', estimate, ceiling })
        continue
      }
      const busyMs = info.provider === 'groq' ? pool.nextFreeInMs() : (capacity?.waitMs(info.id) ?? 0)
      if (busyMs > MAX_RATE_WAIT_MS) {
        misses.push({ model: info, why: `is rate-limited for another ${seconds(busyMs)}` })
        this.deps.trace?.('turn.model_skipped', { model: info.id, reason: 'rate_limited', waitMs: busyMs })
        continue
      }
      if (busyMs > 0) await sleep(busyMs, signal)
      if (k > 0 && misses.length) {
        const prev = misses[misses.length - 1]!
        this.deps.onNotice(`${prev.model.label} ${prev.why}, trying ${info.label}.`)
      }

      let retried = false
      let rotations = 0
      for (;;) {
        if (signal.aborted) return { text: this.text, aborted: true, modelUsed: info.id }
        if (k > 0 || retried || rotations > 0) this.deps.trace?.('turn.attempt', { reason: k > 0 ? 'fallback' : retried ? 'retry' : 'rotate', model: info.id })
        try {
          const outcome = await this.attempt(info, signal)
          capacity?.ok(info.id)
          return outcome
        } catch (e) {
          lastError = e
          if (signal.aborted) return { text: this.text, aborted: true, modelUsed: info.id }
          // Groq limits belong to each key (often a separate account), so the pool tracks those; the model keeps only its size ceiling
          capacity?.learn(info.id, e, info.provider !== 'groq')
          this.deps.log(`turn attempt (${k === 0 ? (retried ? 'retry' : 'primary') : 'fallback'}, ${info.id}) failed: ${describe(e)}`)
          this.deps.trace?.('turn.attempt_failed', { model: info.id, error: describe(e), transient: isTransient(e) })
          // words already spoken can't be taken back: never restart the answer on another model
          if (this.text.length > 0) return { text: this.text, aborted: false, error: describe(e), modelUsed: info.id }

          const keys = info.provider === 'groq' ? pool.size() : 1
          if (info.provider === 'groq' && (isAuthError(e) || isRateLimit(e)) && rotations + 1 < keys && pool.hasUsable()) {
            rotations++ // the pool benched that key; the next one may be another account with its own limit
            continue
          }
          const rateWait = retryAfterMs(e)
          if (isRateLimit(e) && !retried && rateWait !== undefined && rateWait <= MAX_RATE_WAIT_MS) {
            retried = true
            await sleep(rateWait, signal)
            continue
          }
          if (isTransient(e) && !isRateLimit(e) && !isFirstTokenTimeout(e) && !retried) {
            retried = true
            if (this.deps.brain.retryBackoffMs > 0) await sleep(this.deps.brain.retryBackoffMs, signal)
            continue
          }
          misses.push({ model: info, why: missReason(e, info) })
          break
        }
      }
    }
    return { text: this.text, aborted: false, error: misses.length ? misses.map((m) => `${m.model.label} ${m.why}`).join('; ') : describe(lastError), modelUsed: this.deps.model.id }
  }

  private requestChars(): number {
    const system = typeof this.deps.system === 'string' ? this.deps.system.length : this.deps.system.stable.length + this.deps.system.live.length
    return system + JSON.stringify(this.deps.messages).length
  }

  /** The system prompt as the SDK takes it: the stable part marked as a cache breakpoint (tools + rules), the live part after it. */
  private systemFor(): string | SystemModelMessage[] {
    const s = this.deps.system
    if (typeof s === 'string') return s
    return [
      { role: 'system', content: s.stable, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } },
      { role: 'system', content: s.live }
    ]
  }

  private providerOptions(info: ModelInfo): ProviderOptions | undefined {
    const groqEffort = this.deps.brain.groqReasoningEffort
    if (info.provider === 'groq' && info.reasoning && groqEffort !== 'default') return { groq: { reasoningEffort: groqEffort } }
    const claudeEffort = this.deps.brain.claudeEffort
    if (info.provider === 'anthropic' && info.effort && claudeEffort !== 'default') return { anthropic: { effort: claudeEffort } }
    return undefined
  }

  private async attempt(info: ModelInfo, outer: AbortSignal): Promise<RunnerResult> {
    const { model, key } = this.deps.factory.create(info)
    const inner = new AbortController()
    const signal = AbortSignal.any([outer, inner.signal])
    let stallReason = ''
    let timer: NodeJS.Timeout | null = null
    const arm = (ms: number, reason: string): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        stallReason = reason
        inner.abort()
      }, ms)
    }
    const disarm = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }

    // "Still looking." after a tool has been quiet for fillerAfterMs, once per tool call
    let continuation: NodeJS.Timeout | null = null
    const cancelContinuation = (): void => {
      if (continuation) clearTimeout(continuation)
      continuation = null
    }
    const scheduleContinuation = (toolName: string, delayMs: number): void => {
      cancelContinuation()
      continuation = setTimeout(() => {
        continuation = null
        if (signal.aborted || toolsInFlight === 0 || !this.deps.fillerEnabled) return
        const busy = this.deps.speaker.busyForMs()
        if (busy > 0) {
          scheduleContinuation(toolName, Math.max(200, busy))
          return
        }
        const text = continuationFiller()
        this.deps.trace?.('turn.filler', { kind: 'continuation', tool: toolName, text })
        this.deps.speaker.say(text, 'filler')
        this.lastFillerAt = performance.now()
      }, delayMs)
    }

    const chunker = new SentenceChunker(this.deps.speech.maxChars, this.deps.speech.firstMinWords)
    const filter = new SpeakableFilter(this.deps.format)
    let firstToken = false
    let firstSentence = false
    let toolsInFlight = 0
    let lastFinish: string | undefined
    let noteBuf = ''
    const textBefore = this.text
    const fallbackUsed = info.id !== this.deps.model.id

    try {
      arm(this.deps.firstTokenTimeoutMs, 'no response from the model')
      const result = streamText({
        model: model as LanguageModel,
        system: this.systemFor(),
        messages: this.deps.messages,
        tools: this.deps.tools,
        stopWhen: stepCountIs(this.deps.maxSteps),
        abortSignal: signal,
        maxRetries: 0,
        temperature: this.deps.brain.temperature,
        maxOutputTokens: this.deps.brain.maxTokens,
        providerOptions: this.providerOptions(info)
      })

      for await (const part of result.fullStream) {
        // the model is alive but not talking yet: thinking, or streaming a long tool input. Neither is a stall;
        // silent thinking gets the stall budget on top of the first-token budget, every visible delta re-arms
        if (!firstToken && (part.type === 'start-step' || part.type === 'reasoning-start')) arm(this.deps.firstTokenTimeoutMs + this.deps.stallTimeoutMs, 'no response from the model')
        else if (part.type === 'reasoning-delta' || part.type === 'tool-input-start' || part.type === 'tool-input-delta') arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
        switch (part.type) {
          case 'text-delta': {
            if (!firstToken) {
              firstToken = true
              this.metrics.ttftMs = Math.round(performance.now() - this.startedAt)
              this.deps.trace?.('turn.first_token', { ttftMs: this.metrics.ttftMs, model: info.id })
            }
            let delta = part.text
            // the model sometimes parrots the app's bracketed bookkeeping ("[interrupted …]"); never speak it
            if (!this.text.trim()) {
              noteBuf += delta
              const m = /^\s*\[[^\]]{0,200}\]\s*/.exec(noteBuf)
              if (m) {
                this.deps.trace?.('turn.note_echo', { note: m[0].trim() })
                delta = noteBuf.slice(m[0].length).trimStart()
                noteBuf = ''
              } else if (noteBuf.trimStart().startsWith('[') && noteBuf.length < 220 && !noteBuf.includes(']')) {
                arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
                break
              } else {
                delta = noteBuf.trimStart()
                noteBuf = ''
              }
              if (!delta) {
                arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
                break
              }
            }
            this.text += delta
            this.deps.onDelta(delta)
            for (const sentence of chunker.feed(filter.feed(delta))) {
              if (!firstSentence) {
                firstSentence = true
                this.metrics.ttfsMs = Math.round(performance.now() - this.startedAt)
                this.deps.trace?.('turn.first_sentence', { ttfsMs: this.metrics.ttfsMs, chars: sentence.length })
              }
              this.deps.speaker.say(sentence)
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped mid-answer')
            break
          }
          case 'tool-call': {
            toolsInFlight++
            this.deps.onToolStart(part.toolCallId, part.toolName, part.input)
            if (this.deps.fillerEnabled) {
              const now = performance.now()
              // flush whatever the model said before the call so the lead-in follows it immediately
              for (const s of chunker.flush()) this.deps.speaker.say(s)
              if (now - this.lastFillerAt >= this.deps.speech.fillerMinGapMs) {
                const filler = fillerFor(part.toolName)
                this.deps.trace?.('turn.filler', { kind: 'lead-in', tool: part.toolName, text: filler })
                this.deps.speaker.say(filler, 'filler')
                this.lastFillerAt = now
              }
              scheduleContinuation(part.toolName, this.deps.speech.fillerAfterMs)
            }
            this.deps.onCue(true)
            arm(this.deps.toolStallTimeoutMs, `the ${part.toolName} tool took too long`)
            break
          }
          case 'tool-result': {
            toolsInFlight = Math.max(0, toolsInFlight - 1)
            this.deps.onToolEnd(part.toolCallId, part.toolName, true, part.output)
            if (toolsInFlight === 0) {
              this.deps.onCue(false)
              cancelContinuation()
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped after a tool call')
            break
          }
          case 'tool-error': {
            toolsInFlight = Math.max(0, toolsInFlight - 1)
            this.deps.onToolEnd(part.toolCallId, part.toolName, false, undefined, describe(part.error))
            if (toolsInFlight === 0) {
              this.deps.onCue(false)
              cancelContinuation()
            }
            arm(this.deps.stallTimeoutMs, 'the model stopped after a tool error')
            break
          }
          case 'finish-step': {
            this.metrics.steps = (this.metrics.steps ?? 0) + 1
            lastFinish = part.finishReason
            const u = part.usage as { inputTokens?: number | { total?: number }; outputTokens?: number | { total?: number } } | undefined
            const total = (v: number | { total?: number } | undefined): number => (typeof v === 'number' ? v : (v?.total ?? 0))
            this.metrics.inputTokens = (this.metrics.inputTokens ?? 0) + total(u?.inputTokens)
            this.metrics.outputTokens = (this.metrics.outputTokens ?? 0) + total(u?.outputTokens)
            break
          }
          case 'error':
            throw part.error
          case 'abort':
            break
          default:
            break
        }
      }
      disarm()
      cancelContinuation()
      if (inner.signal.aborted && !outer.aborted) throw new Error(`stall: ${stallReason}`)
      if (noteBuf && !this.text.trim()) {
        // an unterminated "[" run at the very start: it was text after all
        this.text += noteBuf
        this.deps.onDelta(noteBuf)
        chunker.feed(filter.feed(noteBuf))
        noteBuf = ''
      }
      for (const s of chunker.flush()) this.deps.speaker.say(s)
      let hitStepLimit = false
      if (lastFinish === 'tool-calls' && (this.metrics.steps ?? 0) >= this.deps.maxSteps) {
        // the model still wanted tools when the round cap hit: say so only if it said nothing else
        hitStepLimit = true
        this.deps.trace?.('turn.step_limit', { steps: this.metrics.steps, maxSteps: this.deps.maxSteps, spoke: this.text.length > 0 })
        if (!this.text.trim()) {
          this.text += STEP_LIMIT_PHRASE
          this.deps.onDelta(STEP_LIMIT_PHRASE)
          this.deps.speaker.say(STEP_LIMIT_PHRASE)
        }
      }
      if (info.provider === 'groq') this.deps.factory.groqPool.report(key, 200)
      this.metrics.totalMs = Math.round(performance.now() - this.startedAt)
      this.metrics.model = info.id
      if (fallbackUsed) this.metrics.fallbackUsed = true
      if (hitStepLimit) this.metrics.hitStepLimit = true
      this.deps.onMetrics(this.metrics)
      return { text: this.text, aborted: outer.aborted, modelUsed: info.id, hitStepLimit }
    } catch (e) {
      disarm()
      cancelContinuation()
      this.deps.onCue(false)
      if (info.provider === 'groq') {
        const s = status(e)
        if (s) this.deps.factory.groqPool.report(key, s, retryAfterMs(e))
      }
      if (outer.aborted) return { text: this.text, aborted: true, modelUsed: info.id }
      if (inner.signal.aborted) {
        this.deps.trace?.('turn.stall', { reason: stallReason, model: info.id, chars: this.text.length })
        if (this.text.length > textBefore.length) {
          for (const s of chunker.flush()) this.deps.speaker.say(s)
          this.deps.onNotice(`Response cut short: ${stallReason}.`)
          this.metrics.model = info.id
          this.metrics.stallReason = stallReason
          if (fallbackUsed) this.metrics.fallbackUsed = true
          this.deps.onMetrics(this.metrics)
          return { text: this.text, aborted: false, error: stallReason, modelUsed: info.id }
        }
        throw new Error(`timeout: ${stallReason}`)
      }
      throw e
    }
  }
}
