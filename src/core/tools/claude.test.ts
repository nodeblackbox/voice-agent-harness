import { describe, expect, it } from 'vitest'
import { ClaudeSessionManager } from '../claude/manager'
import type { CcRunOpts } from '../claude/types'
import { composeSystemPrompt } from '../prompts/compose'
import { claudeContextBlock, claudeTools } from './claude'

const never = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }

function setup() {
  const runs: CcRunOpts[] = []
  const m = new ClaudeSessionManager({
    sdk: (o) => { runs.push(o); return { messages: never, interrupt: async () => {}, close: () => {} } },
    workspaceRoot: 'C:\\fake\\ws', mkdir: () => {}, defaultMode: 'auto',
  })
  const tools = claudeTools(m) as Record<string, { execute: (a: any, o: any) => Promise<any> }>
  const call = (name: string, args: Record<string, unknown> = {}) => tools[name]!.execute(args, { toolCallId: 't', messages: [] })
  return { m, runs, call }
}

const Q = { questions: [{ question: 'Pick one?', header: 'p', multiSelect: false, options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }

describe('claude voice tools', () => {
  it('exposes the session tools', () => {
    expect(Object.keys(claudeTools(setup().m)).sort()).toEqual(
      ['claude_answer', 'claude_attach', 'claude_details', 'claude_files', 'claude_interrupt', 'claude_list', 'claude_mode', 'claude_recent', 'claude_remove', 'claude_reset', 'claude_send', 'claude_start', 'claude_status', 'claude_stop'])
  })

  it('start -> list -> status flow returns immediately with speakable fields', async () => {
    const { call } = setup()
    const started = await call('claude_start', { name: 'Landing page', task: 'build it' })
    expect(started).toMatchObject({ status: 'started', session: { name: 'Landing page', status: 'running', queued_prompts: 0 } })
    const list = await call('claude_list')
    expect(list.sessions).toHaveLength(1)
    expect(await call('claude_status', { session: 'landing' })).toMatchObject({ name: 'Landing page' })
  })

  it('claude_send queues while busy and reports it', async () => {
    const { call } = setup()
    await call('claude_start', { name: 'A', task: 'one' })
    expect(await call('claude_send', { prompt: 'two' })).toMatchObject({ status: 'queued', session: 'A' })
    expect((await call('claude_status', {})).queued_prompts).toBe(1)
  })

  it('surfaces a pending question with numbered options and answers it', async () => {
    const { call, runs } = setup()
    await call('claude_start', { name: 'A', task: 'go' })
    let result: any
    void runs[0]!.canUseTool('AskUserQuestion', Q, {}).then((r) => { result = r })
    await new Promise((r) => setImmediate(r))
    const st = await call('claude_status', { session: 'A' })
    expect(st.waiting_for_user).toMatchObject({ type: 'question' })
    expect(st.waiting_for_user.questions[0].options).toEqual(['1. Alpha', '2. Beta'])
    expect(await call('claude_answer', { session: 'A', choice: [2] })).toMatchObject({ status: 'answered', answer: 'Beta' })
    await new Promise((r) => setImmediate(r))
    expect(result.updatedInput.answers['Pick one?']).toBe('Beta')
  })

  it('claude_mode switches a session; claude_start takes a mode', async () => {
    const { call, m } = setup()
    expect(await call('claude_start', { name: 'P', task: 'go', mode: 'plan' })).toMatchObject({ session: { mode: 'plan' } })
    expect(await call('claude_mode', { session: 'P', mode: 'bypass' })).toMatchObject({ status: 'mode set', mode: 'bypass' })
    expect(m.list()[0]!.mode).toBe('bypass')
  })

  it('keeps plans out of the conversation until asked: headline in status, full text from claude_details', async () => {
    const { call, runs, m } = setup()
    await call('claude_start', { name: 'P', task: 'go', mode: 'plan' })
    const plan = '# Plan: Contact form\n\n1. Markup\n2. Validation\n3. Submit\n\n' + 'Detail. '.repeat(300)
    void runs[0]!.canUseTool('ExitPlanMode', { plan }, {})
    await new Promise((r) => setImmediate(r))
    const st = await call('claude_status', { session: 'P' })
    expect(st.waiting_for_user).toEqual({ type: 'plan', headline: 'Contact form', steps: 3, full_plan: 'claude_details what=plan' })
    expect(JSON.stringify(st).length).toBeLessThan(700)
    expect(claudeContextBlock(m)).toContain('WAITING ON THE USER (plan to approve): Contact form (3 steps')
    expect(claudeContextBlock(m)).not.toContain('Detail.')
    expect((await call('claude_details', { session: 'P', what: 'plan' })).plan).toContain('Validation')
    expect(await call('claude_answer', { session: 'P', approve: false, text: 'skip validation' })).toMatchObject({ status: 'answered', answer: 'sent back with your changes' })
  })

  it('claude_details activity is one short line per step', async () => {
    const { call, m } = setup()
    await call('claude_start', { name: 'A', task: 'x'.repeat(1000) })
    const d = await call('claude_details', { session: 'A', what: 'activity' })
    expect(d.steps.every((l: string) => l.length <= 200)).toBe(true)
    expect(m.list()).toHaveLength(1)
  })

  it('reports clear errors instead of throwing', async () => {
    const { call } = setup()
    expect(await call('claude_status', { session: 'nope' })).toMatchObject({ status: 'failed' })
    await call('claude_start', { name: 'A', task: 'go' })
    expect(await call('claude_answer', { session: 'A', choice: [1] })).toMatchObject({ status: 'failed', error: 'Nothing is waiting for an answer.' })
    expect(await call('claude_answer', { session: 'A' })).toMatchObject({ status: 'failed', error: 'No answer was given.' })
  })

  it('interrupt and stop work by partial name', async () => {
    const { call, m } = setup()
    await call('claude_start', { name: 'Backend', task: 'go' })
    expect(await call('claude_interrupt', { session: 'back', clear_queue: true })).toMatchObject({ status: 'interrupted' })
    expect(await call('claude_stop', { session: 'back' })).toMatchObject({ status: 'stopped' })
    expect(m.list()[0]!.status).toBe('stopped')
  })

  it('ambiguous names ask which one', async () => {
    const { call } = setup()
    await call('claude_start', { name: 'Site one' })
    await call('claude_start', { name: 'Site two' })
    const r = await call('claude_status', { session: 'site' })
    expect(r).toMatchObject({ status: 'failed' })
    expect(r.error).toContain('Site one')
  })
})

describe('claude prompt context', () => {
  it('context block lists sessions and flags what is waiting on the user', async () => {
    const { call, runs, m } = setup()
    expect(claudeContextBlock(m)).toBe('No Claude Code sessions yet.')
    await call('claude_start', { name: 'A', task: 'go' })
    void runs[0]!.canUseTool('AskUserQuestion', Q, {})
    await new Promise((r) => setImmediate(r))
    const block = claudeContextBlock(m)
    expect(block).toContain('WAITING ON THE USER (question)')
    expect(block).toContain('1) Alpha  2) Beta')
  })

  it('the Claude rules appear only when a claudeBlock is supplied', () => {
    const style = { id: 's', label: 'L', desc: '', body: 'b', format: 'plain' as const }
    const base = { agentName: 'Ava', userName: 'Sam', now: 'n', timezone: 'tz', location: 'l', projectName: 'p', memoryBlock: '', skillsBlock: '', toolNames: [], fillerEnabled: true }
    expect(composeSystemPrompt(style as never, base)).not.toContain('Claude Code sessions')
    const withClaude = composeSystemPrompt(style as never, { ...base, claudeBlock: '- A [idle]' })
    expect(withClaude).toContain('Claude Code sessions')
    expect(withClaude).toContain('- A [idle]')
    expect(withClaude).toContain('claude_answer')
  })

  it('claude_remove takes several sessions off the list in one go and reports what is left', async () => {
    const { call } = setup()
    await call('claude_start', { name: 'slop one' })
    await call('claude_start', { name: 'slop two' })
    await call('claude_start', { name: 'test session' })
    const r = await call('claude_remove', { sessions: ['slop one', 'slop two', 'ghost'] })
    expect(r).toMatchObject({ status: 'partly done', removed: ['slop one', 'slop two'], remaining: ['test session'] })
    expect(r.failed).toHaveLength(1)
  })
})
