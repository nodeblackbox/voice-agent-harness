import { describe, expect, it, vi } from 'vitest'
import { JevClient, JevError, safeText, validateAnswers, type QuestionMap } from './client'

const Q: QuestionMap = {
  intent: { type: 'choice', instructions: 'What kind of message is `latest`?', criteria: { task: 'do', idea: 'muse' } },
  risky: { type: 'noul', instructions: 'Is it risky?' }
}
const ANSWERS = { intent: { type: 'choice', choice: 'idea', confidence: 0.8, probabilities: { task: 0.2, idea: 0.8 } }, risky: { type: 'noul', noul: 0.1 } }

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))

describe('JevClient', () => {
  it('posts one request with the model, state and questions, and meters the cost', async () => {
    const fetch = reply(200, { model: 'jev-1.14.0', answers: ANSWERS, usage: { input_tokens: 1000, output_tokens: 3 } })
    let t = 0
    const c = new JevClient({ key: () => 'k1', fetch, now: () => (t += 150) })
    const r = await c.ask({ latest: 'maybe a spend tab' }, Q, { timeoutMs: 500 })
    expect(r.answers.intent).toMatchObject({ choice: 'idea' })
    expect(r).toMatchObject({ inputTokens: 1000, ms: 150, model: 'jev-1.14.0' })
    expect(r.usd).toBeCloseTo(0.000042)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k1')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'jev-1.14.0', state: { latest: 'maybe a spend tab' }, questions: Q })
  })

  it('uses another base URL and model when given (a local jevos)', async () => {
    const fetch = reply(200, { answers: ANSWERS, usage: { input_tokens: 1 } })
    await new JevClient({ key: () => 'k', fetch, baseUrl: () => 'http://127.0.0.1:8080/', model: () => 'jev-latest' }).ask('x', Q, { timeoutMs: 500 })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8080/v1/systemone')
    expect(JSON.parse(init.body as string).model).toBe('jev-latest')
  })

  it('fails fast and says why: no key, HTTP error, firewall page, bad answer, timeout', async () => {
    await expect(new JevClient({ key: () => '' }).ask('x', Q, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'no_key' })
    await expect(new JevClient({ key: () => 'k', fetch: reply(401, '{"error":"bad key"}') }).ask('x', Q, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'http', status: 401 })
    await expect(new JevClient({ key: () => 'k', fetch: reply(403, '<html>blocked</html>') }).ask('x', Q, { timeoutMs: 100 })).rejects.toThrow(/firewall/)
    await expect(new JevClient({ key: () => 'k', fetch: reply(200, { answers: { intent: ANSWERS.intent } }) }).ask('x', Q, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'invalid' })
    const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))))
    const err = await new JevClient({ key: () => 'k', fetch: slow as unknown as typeof fetch }).ask('x', Q, { timeoutMs: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JevError)
    expect(err).toMatchObject({ kind: 'timeout' })
  })

  it('refuses a choice with too few options before sending', async () => {
    const fetch = reply(200, {})
    await expect(new JevClient({ key: () => 'k', fetch }).ask('x', { q: { type: 'choice', instructions: 'x', criteria: { only: null } } }, { timeoutMs: 100 })).rejects.toMatchObject({ kind: 'invalid' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('JevClient.warm', () => {
  it('opens the connection with a cheap call, and does nothing without a key', async () => {
    const fetch = reply(200, { data: [] })
    expect(await new JevClient({ key: () => 'k', fetch }).warm()).not.toBeNull()
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.typesafe.ai/v1/models')
    const none = reply(200, {})
    expect(await new JevClient({ key: () => '', fetch: none }).warm()).toBeNull()
    expect(none).not.toHaveBeenCalled()
  })
})

describe('validateAnswers', () => {
  it('checks probabilities and that the choice is the most likely option', () => {
    expect(validateAnswers(Q, ANSWERS as never)).toBeNull()
    expect(validateAnswers(Q, { ...ANSWERS, risky: { type: 'noul', noul: 1.4 } } as never)).toMatch(/range/)
    expect(validateAnswers(Q, { ...ANSWERS, intent: { ...ANSWERS.intent, choice: 'task' } } as never)).toMatch(/most likely/)
    expect(validateAnswers(Q, { ...ANSWERS, intent: { ...ANSWERS.intent, probabilities: { task: 0.5, idea: 0.8 } } } as never)).toMatch(/add up/)
  })
})

describe('safeText', () => {
  it('replaces shell commands that trip the TypeSafe firewall', () => {
    expect(safeText('try curl -X POST https://x and see\nthen this')).toBe('try [a command]\nthen this')
  })
})
