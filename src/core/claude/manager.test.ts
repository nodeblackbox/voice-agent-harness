import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { digest } from './digest'
import { ClaudeSessionManager } from './manager'
import type { CcManagerEvent, CcPermissionResult, CcRun, CcRunOpts, CcSession } from './types'

const ROOT = path.resolve('C:\\fake-root\\workspaces')
const tick = () => new Promise<void>((r) => setImmediate(r))

/** Scripted stand-in for the SDK: the test pushes messages into `run` and reads what the manager sent. */
class FakeRun implements CcRun {
  prompts: string[] = []
  interrupts = 0
  closed = false
  private buf: any[] = []
  private wake: (() => void) | null = null
  private done = false
  failWith?: Error
  constructor(public opts: CcRunOpts) {
    void (async () => { for await (const m of opts.input as AsyncIterable<any>) this.prompts.push(m.message.content) })()
  }
  emit(m: any) { this.buf.push(m); this.wake?.() }
  end() { this.done = true; this.wake?.() }
  fail(e: Error) { this.failWith = e; this.wake?.() }
  init(sid = 'sdk-1') { this.emit({ type: 'system', subtype: 'init', session_id: sid }) }
  say(text: string) { this.emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) }
  tool(name: string, input: unknown) { this.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }) }
  result(text: string, extra: Record<string, unknown> = {}) { this.emit({ type: 'result', subtype: 'success', result: text, total_cost_usd: 0.01, num_turns: 1, terminal_reason: 'completed', ...extra }) }
  async interrupt() { this.interrupts++; this.emit({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_tools', is_error: true, total_cost_usd: 0, num_turns: 0 }) }
  setPermissionMode?: (mode: 'plan' | 'default') => Promise<void>
  close() { this.closed = true; this.done = true; this.wake?.() }
  messages: AsyncIterable<any> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        for (;;) {
          if (this.failWith) throw this.failWith
          if (this.buf.length) return { value: this.buf.shift(), done: false }
          if (this.done) return { value: undefined, done: true }
          await new Promise<void>((r) => { this.wake = r })
        }
      },
    }),
  }
}

function setup(over: Partial<ConstructorParameters<typeof ClaudeSessionManager>[0]> = {}) {
  const runs: FakeRun[] = []
  const events: CcManagerEvent[] = []
  const saved: CcSession[][] = []
  const m = new ClaudeSessionManager({
    sdk: (o) => { const r = new FakeRun(o); runs.push(r); return r },
    workspaceRoot: ROOT, mkdir: () => {}, persist: (s) => saved.push(s), defaultMode: 'auto', scratch: [], ...over,
  })
  m.on((e) => events.push(e))
  return { m, runs, events, saved, last: () => runs[runs.length - 1] }
}

const QUESTION = { questions: [{ question: 'Which language?', header: 'Lang', multiSelect: false, options: [{ label: 'Python' }, { label: 'TypeScript' }, { label: 'Go' }] }] }

describe('lifecycle', () => {
  it('runs a prompt to completion, tracks sdk id, cost and summary, emits finished', async () => {
    const { m, runs, events } = setup()
    const r = m.start('Alpha', 'make hello.txt')
    expect(r.ok).toBe(true)
    const id = (r as any).session.id
    expect(m.get(id)!.status).toBe('running')
    await tick()
    expect(runs[0]!.prompts).toEqual(['make hello.txt'])
    runs[0]!.init('sdk-abc'); runs[0]!.tool('Write', { file_path: 'hello.txt' }); runs[0]!.result('Created hello.txt')
    await tick()
    const s = m.get(id)!
    expect(s).toMatchObject({ status: 'idle', sdkSessionId: 'sdk-abc', lastSummary: 'Created hello.txt', costUsd: 0.01 })
    expect(events.some((e) => e.type === 'finished' && e.summary === 'Created hello.txt')).toBe(true)
    expect(m.digest(id)).toContain('Write')
  })

  it('creates one workspace per session under the root, unique and contained', () => {
    const { m } = setup()
    const a = (m.start('My App!') as any).session
    const b = (m.start('My App!') as any).session
    expect(a.workspace).toBe(path.join(ROOT, 'my-app'))
    expect(b.workspace).toBe(path.join(ROOT, 'my-app-2'))
    const evil = (m.start('..\\..\\Windows') as any).session
    expect(path.dirname(evil.workspace)).toBe(ROOT)
  })

  it('enforces maxSessions and resolves sessions by partial name', () => {
    const { m } = setup({ maxSessions: 2 })
    m.start('Website'); m.start('Backend API')
    expect(m.start('Third')).toMatchObject({ ok: false })
    expect((m.find('back') as any).session.name).toBe('Backend API')
    expect(m.find('nope')).toMatchObject({ ok: false })
    expect(m.find('')).toMatchObject({ ok: false }) // ambiguous with two sessions
  })
})

describe('queue (stacked prompts)', () => {
  it('queues while busy and drains in order after each result', async () => {
    const { m, runs } = setup()
    const id = (m.start('q', 'one') as any).session.id
    expect(m.send(id, 'two')).toMatchObject({ ok: true, queued: true })
    m.send(id, 'three')
    expect(m.get(id)!.queued).toEqual(['two', 'three'])
    await tick()
    runs[0]!.result('done one'); await tick()
    expect(runs[0]!.prompts).toEqual(['one', 'two'])
    expect(m.get(id)!.queued).toEqual(['three'])
    runs[0]!.result('done two'); await tick()
    runs[0]!.result('done three'); await tick()
    expect(runs[0]!.prompts).toEqual(['one', 'two', 'three'])
    expect(m.get(id)!.status).toBe('idle')
  })

  it('dequeue removes a stacked prompt', () => {
    const { m } = setup()
    const id = (m.start('q', 'one') as any).session.id
    m.send(id, 'two'); m.send(id, 'three')
    expect(m.dequeue(id, 0)).toMatchObject({ ok: true })
    expect(m.get(id)!.queued).toEqual(['three'])
    expect(m.dequeue(id, 5)).toMatchObject({ ok: false })
  })
})

describe('questions and approvals', () => {
  it('surfaces AskUserQuestion, answers by option number, and resumes the run', async () => {
    const { m, runs, events } = setup()
    const id = (m.start('ask', 'go') as any).session.id
    await tick()
    let result: CcPermissionResult | undefined
    void runs[0]!.opts.canUseTool('AskUserQuestion', QUESTION, {}).then((r) => { result = r })
    await tick()
    const s = m.get(id)!
    expect(s.status).toBe('needs_input')
    expect(s.pending).toMatchObject({ kind: 'question' })
    expect(events.some((e) => e.type === 'needs-input')).toBe(true)

    expect(m.answer(id, { kind: 'choice', choices: [9] })).toMatchObject({ ok: false })
    expect(m.answer(id, { kind: 'allow' })).toMatchObject({ ok: false })
    expect(m.answer(id, { kind: 'choice', choices: [2] })).toMatchObject({ ok: true, said: 'TypeScript' })
    await tick()
    expect(result).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which language?': 'TypeScript' } } })
    expect(m.get(id)!.status).toBe('running')
    expect(m.get(id)!.pending).toBeUndefined()
  })

  it('accepts a free-text answer for a single question', async () => {
    const { m, runs } = setup()
    const id = (m.start('ask', 'go') as any).session.id
    await tick()
    let result: any
    void runs[0]!.opts.canUseTool('AskUserQuestion', QUESTION, {}).then((r) => { result = r })
    await tick()
    m.answer(id, { kind: 'text', text: 'Rust please' })
    await tick()
    expect(result.updatedInput.answers['Which language?']).toBe('Rust please')
  })

  it('asks before shell commands in Ask mode; yes and no both flow through', async () => {
    const { m, runs } = setup({ defaultMode: 'ask' })
    const id = (m.start('sh', 'go') as any).session.id
    await tick()
    let a: any, b: any
    void runs[0]!.opts.canUseTool('PowerShell', { command: 'npm test' }, {}).then((r) => { a = r })
    await tick()
    expect(m.get(id)).toMatchObject({ status: 'needs_permission', pending: { kind: 'permission', summary: 'Run: npm test' } })
    m.answer(id, { kind: 'allow' }); await tick()
    expect(a).toMatchObject({ behavior: 'allow', updatedInput: { command: 'npm test' } })

    void runs[0]!.opts.canUseTool('Bash', { command: 'npm install' }, {}).then((r) => { b = r })
    await tick()
    m.answer(id, { kind: 'deny', reason: 'no installs' }); await tick()
    expect(b).toMatchObject({ behavior: 'deny', message: 'no installs' })
  })

  it('auto-allows non-shell tools and, in Auto mode, shell too', async () => {
    const { m, runs } = setup()
    m.start('x', 'go'); await tick()
    expect(await runs[0]!.opts.canUseTool('Write', { file_path: 'a' }, {})).toMatchObject({ behavior: 'allow' })
    expect(await runs[0]!.opts.canUseTool('Bash', { command: 'ls' }, {})).toMatchObject({ behavior: 'allow' })
  })
})

describe('interrupt, stop, resume', () => {
  it('interrupt ends the turn, keeps the queue, and unblocks a pending question', async () => {
    const { m, runs } = setup()
    const id = (m.start('i', 'long task') as any).session.id
    m.send(id, 'later')
    await tick()
    let q: any
    void runs[0]!.opts.canUseTool('AskUserQuestion', QUESTION, {}).then((r) => { q = r })
    await tick()
    expect(await m.interrupt(id)).toMatchObject({ ok: true })
    await tick()
    expect(runs[0]!.interrupts).toBe(1)
    expect(q).toMatchObject({ behavior: 'deny', interrupt: true })
    expect(m.get(id)).toMatchObject({ status: 'idle', queued: ['later'], lastSummary: 'Interrupted.' })
    expect(m.digest(id)).toContain('interrupted')
  })

  it('interrupt with clearQueue drops stacked prompts', async () => {
    const { m } = setup()
    const id = (m.start('i', 'a') as any).session.id
    m.send(id, 'b')
    await tick()
    await m.interrupt(id, { clearQueue: true })
    expect(m.get(id)!.queued).toEqual([])
  })

  it('send with now=true interrupts and redirects to the new prompt', async () => {
    const { m, runs } = setup()
    const id = (m.start('r', 'old plan') as any).session.id
    await tick()
    m.send(id, 'new plan', { now: true })
    await tick(); await tick()
    expect(runs[0]!.interrupts).toBe(1)
    expect(runs[0]!.prompts).toEqual(['old plan', 'new plan'])
    expect(m.get(id)!.status).toBe('running')
  })

  it('stop closes the run; the next send resumes the same SDK session in a new run', async () => {
    const { m, runs } = setup()
    const id = (m.start('s', 'hi') as any).session.id
    await tick()
    runs[0]!.init('sdk-keep'); runs[0]!.result('ok'); await tick()
    await m.stop(id)
    expect(runs[0]!.closed).toBe(true)
    expect(m.get(id)!.status).toBe('stopped')
    m.send(id, 'again'); await tick()
    expect(runs).toHaveLength(2)
    expect(runs[1]!.opts.resume).toBe('sdk-keep')
    expect(runs[1]!.prompts).toEqual(['again'])
  })

  it('restore() brings sessions back stopped and the next send resumes by sdk id', async () => {
    const { m, runs } = setup()
    const snap: CcSession = { id: 'old1', name: 'Old', workspace: path.join(ROOT, 'old'), status: 'running', sdkSessionId: 'sdk-old', queued: ['q1'], lastSummary: 's', costUsd: 1, turns: 3, createdAt: 1, updatedAt: 1, pending: { id: 'p', kind: 'permission', toolName: 'Bash', summary: 'x' } }
    m.restore([snap])
    expect(m.get('old1')).toMatchObject({ status: 'stopped', pending: undefined, queued: ['q1'] })
    m.send('old1', 'continue'); await tick()
    expect(runs[0]!.opts.resume).toBe('sdk-old')
  })

  it('a dropped connection marks the session errored, and a later send reconnects via resume', async () => {
    const { m, runs } = setup()
    const id = (m.start('c', 'go') as any).session.id
    await tick()
    runs[0]!.init('sdk-c'); await tick()
    runs[0]!.fail(new Error('socket closed')); await tick(); await tick()
    expect(m.get(id)).toMatchObject({ status: 'error' })
    expect(m.get(id)!.lastSummary).toContain('socket closed')
    m.send(id, 'retry'); await tick()
    expect(runs[1]!.opts.resume).toBe('sdk-c')
    expect(m.get(id)!.status).toBe('running')
  })

  it('a clean stream end while running becomes stopped (still resumable)', async () => {
    const { m, runs } = setup()
    const id = (m.start('e', 'go') as any).session.id
    await tick()
    runs[0]!.init('sdk-e'); runs[0]!.end(); await tick(); await tick()
    expect(m.get(id)).toMatchObject({ status: 'stopped', sdkSessionId: 'sdk-e' })
  })
})

describe('gate and persistence', () => {
  it('the gate asks about escapes outside the session workspace, refuses the rest, and logs refusals', async () => {
    const { m, runs } = setup()
    const id = (m.start('g', 'go') as any).session.id
    await tick()
    const inside = path.join(ROOT, 'g', 'a.txt')
    expect(runs[0]!.opts.gate('Write', { file_path: inside })).toEqual({ allow: true })
    expect(runs[0]!.opts.gate('Write', { file_path: 'C:\\Windows\\x' })).toMatchObject({ allow: false, ask: true })
    expect(runs[0]!.opts.gate('Write', { file_path: path.join(ROOT, 'other', 'a.txt') })).toMatchObject({ allow: false, ask: true })
    expect(runs[0]!.opts.gate('mcp__x__send', {})).toMatchObject({ allow: false })
    expect(runs[0]!.opts.gate('PowerShell', { command: 'diskpart' })).toMatchObject({ allow: false })
    expect(m.events(id).filter((e) => e.kind === 'denied')).toHaveLength(2)
    expect(m.digest(id)).toContain('2 actions were blocked')
    // an ask the user turns down is logged too
    void runs[0]!.opts.canUseTool('Write', { file_path: 'C:\\Windows\\x' }, { reason: '[fence] Write: C:\\Windows\\x is outside its folder' })
    await tick()
    m.answer(id, { kind: 'deny' })
    expect(m.events(id).filter((e) => e.kind === 'denied')).toHaveLength(3)
  })

  it('persists a snapshot on every change', () => {
    const { m, saved } = setup()
    m.start('p')
    expect(saved.length).toBeGreaterThan(0)
    expect(saved[saved.length - 1]![0]!.name).toBe('p')
  })
})

describe('digest', () => {
  it('summarises only the latest turn', () => {
    const t = (kind: any, text: string) => ({ t: 0, kind, text })
    const d = digest([t('user', 'a'), t('tool', 'Bash x'), t('user', 'b'), t('tool', 'Edit f'), t('tool', 'Edit g'), t('result', 'Fixed it')])
    expect(d).toBe('Used Edit 2 times. Fixed it')
  })
  it('handles empty and clips long text', () => {
    expect(digest([])).toMatch(/Nothing/)
    expect(digest([{ t: 0, kind: 'result', text: 'x'.repeat(500) }], 50).length).toBeLessThanOrEqual(50)
  })
})

describe('rich events and session management', () => {
  it('pairs tool calls with their output, clips big inputs, and records turn stats', async () => {
    const { m, runs } = setup()
    const id = (m.start('rich', 'go') as any).session.id
    await tick()
    runs[0]!.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Write', input: { file_path: 'a.html', content: 'x'.repeat(9000) } }] } })
    runs[0]!.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'File created' }] }] } })
    runs[0]!.emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'boom', is_error: true }] } })
    runs[0]!.result('done', { duration_ms: 4200 })
    await tick()
    const ev = m.events(id)
    const call = ev.find((e) => e.kind === 'tool')!
    expect(call).toMatchObject({ tool: 'Write', toolId: 'tu1', text: 'Write a.html' })
    expect(String(call.input!.content).length).toBeLessThan(8100)
    expect(ev.filter((e) => e.kind === 'tool_result')).toMatchObject([{ toolId: 'tu1', text: 'File created' }, { toolId: 'tu2', text: 'boom', isError: true }])
    expect(ev.find((e) => e.kind === 'result')).toMatchObject({ durationMs: 4200, costUsd: 0.01, turns: 1 })
  })

  it('rename, fresh start (forgets the conversation) and remove', async () => {
    const { m, runs, events } = setup()
    const id = (m.start('old', 'go') as any).session.id
    await tick()
    runs[0]!.init('sdk-x'); runs[0]!.result('ok'); await tick()
    expect(m.rename(id, '  New name ')).toEqual({ ok: true })
    expect(m.get(id)!.name).toBe('New name')
    expect(await m.reset(id)).toEqual({ ok: true })
    expect(m.get(id)).toMatchObject({ status: 'idle', sdkSessionId: undefined })
    m.send(id, 'again'); await tick()
    expect(runs[1]!.opts.resume).toBeUndefined()
    expect(await m.remove(id)).toEqual({ ok: true })
    expect(m.list()).toEqual([])
    expect(events.some((e) => e.type === 'removed' && e.id === id)).toBe(true)
    expect(await m.remove(id)).toMatchObject({ ok: false })
  })
})

describe('saved sessions (browse and attach)', () => {
  const history = (cwd: string) => ({
    list: async () => [
      { sessionId: 'old-1', title: 'Fix the build', cwd, lastModified: 5 },
      { sessionId: 'mine', title: 'ours', cwd: path.join(ROOT, 'x'), lastModified: 4 }
    ],
    messages: async () => [
      { type: 'user', message: { content: 'Fix the build' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed.' }] } }
    ]
  })
  const PROJECT = path.resolve('.')

  it('lists saved sessions except the ones in our own workspace root', async () => {
    const { m } = setup({ history: history(PROJECT) })
    expect((await m.external()).map((x) => x.sessionId)).toEqual(['old-1'])
    expect((await m.externalEvents('old-1')).map((e) => e.kind)).toEqual(['user', 'text'])
  })

  it('attach brings it in with its transcript; the first run forks, later runs resume the fork; its mode applies', async () => {
    const { m, runs } = setup({ history: history(PROJECT), defaultMode: 'ask' })
    const r = await m.attach({ sessionId: 'old-1', title: 'Fix the build', cwd: PROJECT })
    expect(r.ok).toBe(true)
    const id = (r as any).session.id
    expect(m.get(id)).toMatchObject({ external: true, workspace: PROJECT, sdkSessionId: 'old-1', forkOnResume: true, status: 'idle' })
    expect(m.events(id).map((e) => e.kind)).toEqual(['user', 'text', 'status'])
    expect((await m.external()).map((x) => x.sessionId)).toEqual([]) // already in the list
    m.send(id, 'carry on'); await tick()
    expect(runs[0]!.opts).toMatchObject({ resume: 'old-1', fork: true, cwd: PROJECT })
    runs[0]!.init('forked-9'); await tick()
    expect(m.get(id)).toMatchObject({ sdkSessionId: 'forked-9', forkOnResume: undefined })
    // Ask mode: shell asks
    void runs[0]!.opts.canUseTool('PowerShell', { command: 'npm test' }, {})
    await tick()
    expect(m.get(id)!.status).toBe('needs_permission')
    // a missing folder is refused
    expect(await m.attach({ sessionId: 'gone', title: 'x', cwd: path.join(PROJECT, 'does-not-exist') })).toMatchObject({ ok: false })
  })
})

describe('billing', () => {
  it('records that a run is on the Claude subscription', async () => {
    const { m, last } = setup()
    const id = (m.start('Sub', 'hi') as any).session.id
    await tick()
    last()!.emit({ type: 'system', subtype: 'init', session_id: 'sdk-1', apiKeySource: 'none' })
    await tick()
    expect(m.get(id)!.billing).toBe('subscription')
  })

  it('stops a run that would bill an API key before it does anything', async () => {
    const { m, last } = setup()
    const id = (m.start('Keyed', 'hi') as any).session.id
    await tick()
    const run = last()!
    run.emit({ type: 'system', subtype: 'init', session_id: 'sdk-1', apiKeySource: 'ANTHROPIC_API_KEY' })
    run.say('should never be seen')
    await tick(); await tick()
    const s = m.get(id)!
    expect(run.closed).toBe(true)
    expect(s).toMatchObject({ status: 'error', billing: 'api-key' })
    expect(s.lastSummary).toContain('API key')
    expect(m.events(id).some((e) => e.kind === 'text')).toBe(false)
  })
})

/** A pending canUseTool call: resolves into `got.r`. */
function ask(run: FakeRun, tool: string, input: Record<string, unknown>, meta: { reason?: string } = {}) {
  const got: { r?: CcPermissionResult } = {}
  void run.opts.canUseTool(tool, input, meta).then((r) => { got.r = r })
  return got
}
const PLAN = '# Plan: Add a contact form\n\n1. Add form markup\n2. Validate fields\n3. Wire submit'

describe('modes', () => {
  it('new sessions take the default mode, or the one asked for; the CLI starts in plan mode only for Plan', async () => {
    const { m, runs } = setup({ defaultMode: 'auto' })
    const a = (m.start('A', 'go') as any).session
    const b = (m.start('B', 'go', { mode: 'plan' }) as any).session
    await tick()
    expect(a.mode).toBe('auto')
    expect(b.mode).toBe('plan')
    expect(runs.map((r) => r.opts.permissionMode)).toEqual(['default', 'plan'])
  })

  it('the gate uses the fenced policy, and bypass once switched', async () => {
    const { m, runs } = setup()
    const id = (m.start('G', 'go') as any).session.id
    await tick()
    const outside = path.resolve('C:\\elsewhere\\x.txt')
    expect(runs[0]!.opts.gate('Write', { file_path: outside })).toMatchObject({ allow: false, ask: true })
    m.setMode(id, 'bypass')
    expect(runs[0]!.opts.gate('Write', { file_path: outside })).toMatchObject({ allow: true })
    expect(runs[0]!.opts.gate('PowerShell', { command: 'format C:' })).toMatchObject({ allow: false })
  })

  it('a fence "ask" becomes an approval with its reason, in any mode', async () => {
    const { m, runs, events } = setup({ defaultMode: 'auto' })
    const id = (m.start('F', 'go') as any).session.id
    await tick()
    const got = ask(runs[0]!, 'PowerShell', { command: 'rm -rf build' }, { reason: '[fence] PowerShell: deletes files' })
    await tick()
    expect(m.get(id)).toMatchObject({ status: 'needs_permission', pending: { kind: 'permission', summary: 'Run: rm -rf build', reason: 'deletes files' } })
    expect(events.some((e) => e.type === 'needs-input')).toBe(true)
    m.answer(id, { kind: 'allow' }); await tick()
    expect(got.r).toMatchObject({ behavior: 'allow' })
  })

  it('"yes, and stop asking": an approval can switch the mode', async () => {
    const { m, runs } = setup({ defaultMode: 'ask' })
    const id = (m.start('Y', 'go') as any).session.id
    await tick()
    const got = ask(runs[0]!, 'Bash', { command: 'npm test' })
    await tick()
    expect(m.answer(id, { kind: 'allow', mode: 'auto' })).toMatchObject({ ok: true })
    await tick()
    expect(got.r).toMatchObject({ behavior: 'allow' })
    expect(m.get(id)!.mode).toBe('auto')
    expect(await runs[0]!.opts.canUseTool('Bash', { command: 'npm run lint' }, {})).toMatchObject({ behavior: 'allow' })
  })

  it('switching to Auto lets a waiting shell approval through; a fence reason still waits; Bypass lets that through too', async () => {
    const { m, runs } = setup({ defaultMode: 'ask' })
    const id = (m.start('S', 'go') as any).session.id
    await tick()
    const plain = ask(runs[0]!, 'Bash', { command: 'npm test' })
    await tick()
    m.setMode(id, 'auto'); await tick()
    expect(plain.r).toMatchObject({ behavior: 'allow' })
    const fenced = ask(runs[0]!, 'Bash', { command: 'git push' }, { reason: '[fence] Bash: risky command (git push)' })
    await tick()
    m.setMode(id, 'auto'); await tick()
    expect(fenced.r).toBeUndefined()
    m.setMode(id, 'bypass'); await tick()
    expect(fenced.r).toMatchObject({ behavior: 'allow' })
  })

  it('tells the live CLI when it enters or leaves plan mode', async () => {
    const calls: string[] = []
    const { m, runs } = setup()
    const id = (m.start('P', 'go') as any).session.id
    await tick()
    runs[0]!.setPermissionMode = async (x) => { calls.push(x) }
    m.setMode(id, 'plan'); m.setMode(id, 'ask'); m.setMode(id, 'bypass')
    await tick()
    expect(calls).toEqual(['plan', 'default'])
  })
})

describe('plans', () => {
  it('ExitPlanMode waits for approval with a headline; approving leaves plan mode first, then builds in the mode it had before', async () => {
    const calls: string[] = []
    const { m, runs, events } = setup({ defaultMode: 'auto' })
    const id = (m.start('Plan', 'go', { mode: 'plan' }) as any).session.id
    await tick()
    runs[0]!.setPermissionMode = async (x) => { calls.push(x) }
    const got = ask(runs[0]!, 'ExitPlanMode', { plan: PLAN, planFilePath: 'C:\\x.md' })
    await tick()
    expect(m.get(id)).toMatchObject({ status: 'needs_permission', pending: { kind: 'plan', summary: 'Add a contact form', plan: PLAN } })
    expect(events.find((e) => e.type === 'needs-input')).toBeTruthy()
    expect(m.answer(id, { kind: 'allow' })).toMatchObject({ ok: true, said: 'plan approved, building in Auto mode' })
    await tick(); await tick()
    expect(calls).toEqual(['default'])
    expect(got.r).toMatchObject({ behavior: 'allow', updatedInput: { plan: PLAN } })
    expect(m.get(id)).toMatchObject({ mode: 'auto', status: 'running', pending: undefined })
  })

  it('a plan can be approved into a chosen mode, or sent back with feedback', async () => {
    const { m, runs } = setup()
    const id = (m.start('Plan', 'go', { mode: 'plan' }) as any).session.id
    await tick()
    const first = ask(runs[0]!, 'ExitPlanMode', { plan: PLAN })
    await tick()
    expect(m.answer(id, { kind: 'text', text: 'use Postgres' })).toMatchObject({ ok: true, said: 'sent back with your changes' })
    await tick()
    expect(first.r).toMatchObject({ behavior: 'deny' })
    expect((first.r as any).message).toContain('use Postgres')
    expect(m.get(id)!.mode).toBe('plan')
    const second = ask(runs[0]!, 'ExitPlanMode', { plan: PLAN })
    await tick()
    m.answer(id, { kind: 'allow', mode: 'bypass' }); await tick(); await tick()
    expect(second.r).toMatchObject({ behavior: 'allow' })
    expect(m.get(id)!.mode).toBe('bypass')
  })

  it('switching mode while a plan waits approves it into that mode', async () => {
    const { m, runs } = setup()
    const id = (m.start('Plan', 'go', { mode: 'plan' }) as any).session.id
    await tick()
    const got = ask(runs[0]!, 'ExitPlanMode', { plan: PLAN })
    await tick()
    m.setMode(id, 'ask'); await tick(); await tick()
    expect(got.r).toMatchObject({ behavior: 'allow' })
    expect(m.get(id)!.mode).toBe('ask')
  })

  it('follows the model into plan mode when it enters it by itself', async () => {
    const { m, runs } = setup({ defaultMode: 'ask' })
    const id = (m.start('Self', 'go') as any).session.id
    await tick()
    runs[0]!.emit({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' })
    await tick()
    expect(m.get(id)!.mode).toBe('plan')
    const got = ask(runs[0]!, 'ExitPlanMode', { plan: PLAN })
    await tick()
    m.answer(id, { kind: 'allow' }); await tick(); await tick()
    expect(got.r).toMatchObject({ behavior: 'allow' })
    expect(m.get(id)!.mode).toBe('ask')
  })
})
