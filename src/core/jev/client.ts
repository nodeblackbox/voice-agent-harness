// Jev: TypeSafe's fast decision model (System One API). It reads a short state and answers fixed-form
// questions (yes/no as a probability, or one of several named options with a confidence) in a few hundred
// milliseconds. Ported from the owner's Jev playground, cut down for a live voice turn: one request per
// turn, a hard timeout (the playground had none), no cache and no retries, because a late answer is no
// answer. The request shape and the answer checks are the playground's. Prices are TypeSafe's list price.

export type JevModel = 'jev-latest' | 'jev-preview' | 'jev-1.14.0' | 'jev-1.13.0'

export interface NoulQ {
  type: 'noul'
  instructions: string
  /** What true and false mean; give both whenever "yes" could be read two ways. */
  criteria?: { true: string; false: string }
}

export interface ChoiceQ {
  type: 'choice'
  instructions: string
  /** Option key -> description. 2 to 255 options. */
  criteria: Record<string, string | null>
}

export type Question = NoulQ | ChoiceQ
export type QuestionMap = Record<string, Question>

export interface NoulA {
  type: 'noul'
  /** Probability that the answer is true. */
  noul: number
}

export interface ChoiceA {
  type: 'choice'
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export type Answer = NoulA | ChoiceA

export interface JevResult {
  answers: Record<string, Answer>
  inputTokens: number
  usd: number
  ms: number
  model: string
}

export const JEV_PRICE_PER_INPUT_TOKEN = 0.042 / 1e6
export const JEV_DEFAULT_MODEL: JevModel = 'jev-1.14.0'
export const JEV_DEFAULT_BASE = 'https://api.typesafe.ai'

export type JevErrorKind = 'no_key' | 'timeout' | 'http' | 'invalid' | 'network' | 'cancelled'

export class JevError extends Error {
  constructor(
    message: string,
    readonly kind: JevErrorKind,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface JevClientOptions {
  key: () => string | undefined
  /** Another server with the same protocol (a local jevos) goes here. */
  baseUrl?: () => string
  model?: () => string
  fetch?: typeof fetch
  now?: () => number
}

/** Checks each answer matches its question: probabilities in range and summing to about 1, choice = most likely. */
export function validateAnswers(questions: QuestionMap, answers: Record<string, Answer> | undefined): string | null {
  if (!answers || typeof answers !== 'object') return 'no answers'
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name]
    if (!a || a.type !== q.type) return `${name}: missing or wrong type`
    if (a.type === 'noul' && !(typeof a.noul === 'number' && a.noul >= 0 && a.noul <= 1)) return `${name}: probability out of range`
    if (a.type === 'choice') {
      const ps = Object.entries(a.probabilities ?? {})
      const sum = ps.reduce((s, [, p]) => s + p, 0)
      const top = [...ps].sort((x, y) => y[1] - x[1])[0]?.[0]
      if (Math.abs(sum - 1) > 0.03) return `${name}: probabilities add up to ${sum.toFixed(3)}`
      if (top !== a.choice) return `${name}: answer ${a.choice} is not the most likely option ${top}`
    }
  }
  return null
}

/**
 * TypeSafe's firewall answers HTML 403 when the state holds shell-like text (`curl -X POST`); a pasted
 * command must not cost the user the whole check, so those spans are replaced.
 */
export function safeText(text: string): string {
  return text.replace(/\b(curl|wget|Invoke-WebRequest|iwr)\b[^\n]*/gi, '[a command]')
}

export class JevClient {
  constructor(private readonly o: JevClientOptions) {}

  configured(): boolean {
    return !!this.o.key()?.trim()
  }

  /**
   * Open the connection ahead of the first message: the first call of a run spends about 300 ms setting it up
   * (measured: 400 ms cold, 120-170 ms after, even 20 s apart). A cheap listing call; its answer is ignored.
   */
  async warm(timeoutMs = 5000): Promise<number | null> {
    const key = this.o.key()?.trim()
    if (!key) return null
    const now = this.o.now ?? Date.now
    const t0 = now()
    try {
      const res = await (this.o.fetch ?? fetch)(`${(this.o.baseUrl?.() || JEV_DEFAULT_BASE).replace(/\/+$/, '')}/v1/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs) })
      await res.text()
      return now() - t0
    } catch {
      return null
    }
  }

  async ask(state: unknown, questions: QuestionMap, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<JevResult> {
    const key = this.o.key()?.trim()
    if (!key) throw new JevError('no TypeSafe key', 'no_key')
    for (const [name, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        const n = Object.keys(q.criteria).length
        if (n < 2 || n > 255) throw new JevError(`${name}: a choice needs 2 to 255 options, not ${n}`, 'invalid')
      }
    }
    const model = this.o.model?.() || JEV_DEFAULT_MODEL
    const base = (this.o.baseUrl?.() || JEV_DEFAULT_BASE).replace(/\/+$/, '')
    const now = this.o.now ?? Date.now
    const timeout = AbortSignal.timeout(Math.max(1, opts.timeoutMs))
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
    const t0 = now()
    let res: Response
    try {
      res = await (this.o.fetch ?? fetch)(`${base}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, state, questions }),
        signal
      })
    } catch (e) {
      if (timeout.aborted) throw new JevError(`no answer within ${opts.timeoutMs} ms`, 'timeout')
      if (opts.signal?.aborted) throw new JevError('cancelled', 'cancelled')
      throw new JevError(`could not reach TypeSafe: ${(e as Error).message}`, 'network')
    }
    let text = ''
    try {
      text = await res.text()
    } catch (e) {
      if (timeout.aborted) throw new JevError(`no answer within ${opts.timeoutMs} ms`, 'timeout')
      throw new JevError(`the answer broke off: ${(e as Error).message}`, 'network')
    }
    const ms = now() - t0
    if (res.status !== 200) {
      const detail = /^\s*</.test(text) ? 'an HTML page (the firewall may have blocked the text)' : text.slice(0, 200)
      throw new JevError(`TypeSafe answered ${res.status}: ${detail}`, 'http', res.status)
    }
    let body: { model?: string; answers?: Record<string, Answer>; usage?: { input_tokens?: number } }
    try {
      body = JSON.parse(text)
    } catch {
      throw new JevError('TypeSafe answered with something that is not JSON', 'invalid')
    }
    const bad = validateAnswers(questions, body.answers)
    if (bad) throw new JevError(`unusable answer: ${bad}`, 'invalid')
    const inputTokens = body.usage?.input_tokens ?? 0
    return { answers: body.answers!, inputTokens, usd: inputTokens * JEV_PRICE_PER_INPUT_TOKEN, ms, model: body.model ?? model }
  }
}
