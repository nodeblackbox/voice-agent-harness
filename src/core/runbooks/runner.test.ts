import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunbookRun } from '@shared/types'
import { parsePlaybook, type Playbook } from '../playbooks/schema'
import { JevClient } from '../jev/client'
import { RunbookRunner, fill, toList, type RunnerDeps } from './runner'

const book = (id: string, steps: string, extra = ''): Playbook => {
  const r = parsePlaybook(id, `---\nkind: runbook\ntitle: ${id}\ngoal: Test.\ntriggers:\n  said: ["two words"]\n${extra}steps:\n${steps}\n---\nNotes.\n`)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.playbook
}

const TASKS = `  - id: tasks
    do: model
    prompt: "List the tasks in {{text}}"
    save: tasks
    list: true
  - id: any
    do: check
    if: "tasks_count > 0"
    next: { yes: offer, no: end }
  - id: offer
    do: say
    text: "I found {{tasks_count}} tasks: {{tasks}}. Add them?"
  - id: reply
    do: wait
    expireS: 60
  - id: agree
    do: ask
    question: "Is \`latest\` agreeing to go ahead?"
    next: { no: end }
  - id: add
    do: tool
    tool: remember
    each: tasks
    args: { key: "Task: {{item}}", value: "{{item}}", kind: todo }`

function setup(over: Partial<RunnerDeps> = {}) {
  const saved = new Map<string, RunbookRun>()
  const traces: Array<{ ev: string; data: Record<string, unknown> }> = []
  const deps: RunnerDeps = {
    generate: vi.fn(async (prompt: string) => ({ text: prompt.startsWith('List') ? '- write the spend tab\n- push the branch\n' : 'yes' })),
    say: vi.fn(),
    tool: vi.fn(async () => ({ status: 'saved' })),
    claude: vi.fn(() => ({ ok: true, note: 'started "fix"' })),
    save: (r) => saved.set(r.runId, structuredClone(r)),
    trace: (ev, data) => traces.push({ ev, data }),
    ...over
  }
  const runner = new RunbookRunner(deps)
  const settle = () => vi.waitFor(() => expect(runner.list().every((r) => r.status !== 'running')).toBe(true))
  return { runner, deps, saved, traces, settle }
}

let runner: RunbookRunner | undefined
afterEach(() => runner?.dispose())

describe('RunbookRunner', () => {
  it('runs the steps, waits for the reply, and carries on with it', async () => {
    const t = setup()
    runner = t.runner
    const run = t.runner.start(book('tasks', TASKS), { text: 'I need to write the spend tab and push the branch', recent: '' })!
    await t.settle()
    expect(run.status).toBe('waiting')
    expect(t.deps.say).toHaveBeenCalledWith('I found 2 tasks: write the spend tab; push the branch. Add them?')
    expect(t.saved.get(run.runId)!.status).toBe('waiting')

    expect(t.runner.deliverReply('yes, add them')).toEqual({ runId: run.runId, runbookId: 'tasks', title: 'tasks', question: 'I found 2 tasks: write the spend tab; push the branch. Add them?' })
    await t.settle()
    expect(run.status).toBe('done')
    expect(t.deps.tool).toHaveBeenCalledTimes(2)
    expect(t.deps.tool).toHaveBeenCalledWith('remember', { key: 'Task: write the spend tab', value: 'write the spend tab', kind: 'todo' }, expect.anything())
    expect(run.log.map((l) => `${l.step}:${l.outcome}`)).toEqual(['tasks:ok', 'any:ok', 'offer:ok', 'reply:ok', 'agree:ok', 'add:ok'])
    expect(run.scratch.reply).toBe('yes, add them')
    expect(t.runner.deliverReply('anything')).toBeNull()
  })

  it('stops on a no, and on an empty list before saying anything', async () => {
    const t = setup({ generate: vi.fn(async (p: string) => ({ text: p.startsWith('List') ? 'NONE' : 'no' })) })
    runner = t.runner
    const run = t.runner.start(book('tasks', TASKS), { text: 'just chatting', recent: '' })!
    await t.settle()
    expect(run.status).toBe('done')
    expect(t.deps.say).not.toHaveBeenCalled()
  })

  it('expires a wait nobody answers', async () => {
    vi.useFakeTimers()
    try {
      const t = setup()
      runner = t.runner
      const run = t.runner.start(book('tasks', TASKS), { text: 'x', recent: '' })!
      await vi.waitFor(() => expect(run.status).toBe('waiting'))
      vi.advanceTimersByTime(61_000)
      expect(run).toMatchObject({ status: 'expired', reason: 'no reply in time' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a loop at its step budget', async () => {
    const t = setup()
    runner = t.runner
    const loop = book('loop', `  - id: again\n    do: check\n    if: "1 == 1"\n    next: { yes: again, no: end }`, 'budget:\n  maxSteps: 5\n')
    const run = t.runner.start(loop, { text: 'x', recent: '' })!
    await t.settle()
    expect(run).toMatchObject({ status: 'out_of_budget', steps: 5, reason: 'reached 5 steps' })
  })

  it('starts a Claude Code session only after the reply, and blocks the run when it cannot', async () => {
    const steps = `  - id: brief\n    do: model\n    prompt: "List the brief for {{text}}"\n    save: brief\n  - id: offer\n    do: say\n    text: "Start it?"\n  - id: reply\n    do: wait\n  - id: go\n    do: claude\n    name: fix\n    prompt: "{{brief}}"\n    folder: app`
    const t = setup()
    runner = t.runner
    const run = t.runner.start(book('change', steps), { text: 'make the chips bigger', recent: '' })!
    await t.settle()
    t.runner.deliverReply('yes')
    await t.settle()
    expect(run.status).toBe('done')
    expect(t.deps.claude).toHaveBeenCalledWith({ name: 'fix' }, expect.stringContaining('- write the spend tab'), 'app')

    const t2 = setup({ claude: vi.fn(() => ({ ok: false, note: 'Claude Code is off' })) })
    const run2 = t2.runner.start(book('change', steps), { text: 'x', recent: '' })!
    await t2.settle()
    t2.runner.deliverReply('yes')
    await t2.settle()
    expect(run2).toMatchObject({ status: 'blocked', reason: 'step "go" failed: Claude Code is off' })
    t2.runner.dispose()
  })

  it('asks Jev when it can, choice questions included', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: { q: { type: 'choice', choice: 'later', confidence: 0.9, probabilities: { now: 0.1, later: 0.9 } } }, usage: { input_tokens: 10 } })))
    const t = setup({ jev: () => ({ client: new JevClient({ key: () => 'k', fetch: fetch as never }), timeoutMs: 500 }) })
    runner = t.runner
    const rb = book('pick', `  - id: when\n    do: ask\n    question: "When does \`latest\` want it done?"\n    options: { now: "right away", later: "add it to the list" }\n    save: choice\n    next: { now: start, later: note }\n  - id: start\n    do: say\n    text: "starting"\n    next: end\n  - id: note\n    do: say\n    text: "noted"`)
    const run = t.runner.start(rb, { text: 'add it to the list for later', recent: '' })!
    await t.settle()
    expect(run.scratch.choice).toBe('later')
    expect(t.deps.say).toHaveBeenCalledWith('noted')
    expect(t.deps.generate).not.toHaveBeenCalled()
  })

  it('runs one copy of a runbook at a time, and cancels', async () => {
    const t = setup()
    runner = t.runner
    const rb = book('tasks', TASKS)
    const run = t.runner.start(rb, { text: 'x', recent: '' })!
    expect(t.runner.start(rb, { text: 'y', recent: '' })).toBeNull()
    await t.settle()
    expect(t.runner.cancel(run.runId)).toBe(true)
    expect(run.status).toBe('cancelled')
    expect(t.traces.find((x) => x.ev === 'runbook.skipped')!.data).toEqual({ id: 'tasks', reason: 'already_running' })
  })

  it('starts nothing new while a run waits for a reply, so the next message is clearly its answer', async () => {
    const t = setup()
    runner = t.runner
    t.runner.start(book('tasks', TASKS), { text: 'x', recent: '' })
    await t.settle()
    const other = book('other', `  - id: hi\n    do: say\n    text: hello`)
    expect(t.runner.start(other, { text: 'y', recent: '' })).toBeNull()
    expect(t.traces.find((x) => x.ev === 'runbook.skipped')!.data).toEqual({ id: 'other', reason: 'waiting_for_reply' })
    t.runner.deliverReply('no thanks')
    await t.settle()
    expect(t.runner.start(other, { text: 'y', recent: '' })).not.toBeNull()
  })

  it('after a restart, picks a waiting run back up and marks one cut off mid-step', async () => {
    const t = setup()
    runner = t.runner
    const rb = book('tasks', TASKS)
    const run = t.runner.start(rb, { text: 'x', recent: '' })!
    await t.settle()
    const waiting = structuredClone(t.saved.get(run.runId)!)
    const cut: RunbookRun = { ...structuredClone(waiting), runId: 'cut', status: 'running', waiting: undefined }
    t.runner.dispose()

    const t2 = setup()
    runner = t2.runner
    t2.runner.resume([waiting, cut], (id) => (id === 'tasks' ? rb : undefined))
    expect(t2.runner.list().find((r) => r.runId === 'cut')).toMatchObject({ status: 'interrupted' })
    t2.runner.deliverReply('yes')
    await t2.settle()
    expect(t2.runner.list().find((r) => r.runId === run.runId)!.status).toBe('done')
    expect(t2.deps.tool).toHaveBeenCalledTimes(2)
  })
})

describe('fill and toList', () => {
  it('fills saved values and turns a model answer into items', () => {
    expect(fill('{{a}} / {{b}} / {{missing}} / {{n}}', { a: 'x', b: ['p', 'q'], n: 3 })).toBe('x / p; q /  / 3')
    expect(fill('Tasks:\n{{b|lines}}', { b: ['p', 'q'] })).toBe('Tasks:\n- p\n- q')
    expect(toList('1. one\n- two\n\n* three\nNONE')).toEqual(['one', 'two', 'three'])
  })
})
