import { describe, expect, it } from 'vitest'
import { parsePlaybook } from '../playbooks/schema'
import { runbookMermaid } from './steps'

const file = (steps: string) => `---\nkind: runbook\ntitle: R\ngoal: Test.\ntriggers:\n  said: ["two words"]\nsteps:\n${steps}\n---\n`
const errors = (steps: string): string[] => {
  const r = parsePlaybook('r', file(steps))
  return r.ok ? [] : r.errors.map((e) => `${e.line}: ${e.message}`)
}

describe('runbook steps', () => {
  it('accepts a runbook with no body (the body is only notes) and fills defaults', () => {
    const r = parsePlaybook('r', file('  - id: hi\n    do: say\n    text: hello'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.playbook.runbook!.steps[0]).toEqual({ id: 'hi', do: 'say', text: 'hello' })
    expect(r.playbook.budget).toEqual({ maxSteps: 15, maxSeconds: 120 })
  })

  it('reports bad steps on their line: unknown kind, unknown field, unknown target, duplicate id', () => {
    expect(errors('  - id: a\n    do: dance')[0]).toBe('9: step 1: do must be one of model, check, ask, say, wait, tool, claude')
    expect(errors('  - id: a\n    do: say\n    text: x\n    loud: true')).toEqual(['11: unknown field "loud" in step 1'])
    expect(errors('  - id: a\n    do: say\n    text: x\n    next: nowhere')[0]).toMatch(/goes to "nowhere", which is not a step/)
    expect(errors('  - id: a\n    do: say\n    text: x\n  - id: a\n    do: say\n    text: y')[0]).toMatch(/two steps are called "a"/)
  })

  it('checks conditions, answer branches, allowed tools, and that claude comes after a wait', () => {
    expect(errors('  - id: c\n    do: check\n    if: "x >"\n    next: { yes: end, no: end }')[0]).toMatch(/step "c": the expression ends too early/)
    expect(errors('  - id: q\n    do: ask\n    question: "Is `latest` a yes?"\n    next: { maybe: end }')[0]).toMatch(/"maybe" is not an answer/)
    expect(errors('  - id: t\n    do: tool\n    tool: delete_everything')[0]).toMatch(/tool must be one of remember/)
    expect(errors('  - id: go\n    do: claude\n    name: x\n    prompt: do the thing')[0]).toMatch(/must come after a wait step/)
  })

  it('refuses steps on a playbook, and a runbook with none', () => {
    const pb = parsePlaybook('p', '---\ntitle: P\ngoal: x.\nsteps:\n  - id: a\n    do: say\n    text: x\n---\nBody\n')
    expect(!pb.ok && pb.errors[0]!.message).toMatch(/set kind: runbook/)
    expect(errors('  []')[0]).toMatch(/needs a list of steps/)
  })

  it('draws the flow, branches and the implicit unsure stop included', () => {
    const r = parsePlaybook('r', file('  - id: wait\n    do: wait\n  - id: ok\n    do: ask\n    question: "Is `latest` a yes?"\n    next: { no: end }\n  - id: hi\n    do: say\n    text: "[hello] {there}"'))
    if (!r.ok) throw new Error('parse')
    expect(runbookMermaid(r.playbook.runbook!.steps)).toBe(
      [
        'flowchart TD',
        '  start((start))',
        '  wait(["wait: wait for reply → reply"])',
        '  ok{"ok: ask: Is `latest` a yes?"}',
        '  hi["hi: say: [hello] {there}"]',
        '  end_((end))',
        '  start --> wait',
        '  wait --> ok',
        '  ok -->|no| end_',
        '  ok -->|yes| hi',
        '  ok -->|unsure| end_',
        '  hi --> end_'
      ].join('\n')
    )
  })
})
