import { describe, expect, it } from 'vitest'
import { PlaybookEngine, type EngineLimits, type TurnFacts } from './engine'
import { parsePlaybook, type Playbook } from './schema'
import { TEMPLATES } from './templates'

const pb = (id: string, header: string, body = `Instruction for ${id}.`): Playbook => {
  const r = parsePlaybook(id, `---\ntitle: ${id}\ngoal: Goal of ${id}.\n${header}\n---\n${body}\n`)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.playbook
}

const facts = (text: string, extra: Partial<TurnFacts> = {}): TurnFacts => ({ text, via: 'voice', project: '', projectId: '', turnIndex: 0, fromSplit: false, ...extra })
const limits: EngineLimits = { maxInjected: 3, injectMaxChars: 1200, tuning: { longMessageChars: 50 } }

function setup(now = { t: 0 }) {
  const events: Array<{ ev: string; data: Record<string, unknown> }> = []
  const engine = new PlaybookEngine((ev, data) => events.push({ ev, data }), () => now.t)
  return { engine, events, now }
}

describe('PlaybookEngine', () => {
  it('fires the long-message template only on long messages, and says why', () => {
    const r = parsePlaybook(TEMPLATES[0]!.id, TEMPLATES[0]!.text)
    if (!r.ok) throw new Error('template')
    const { engine, events } = setup()
    expect(engine.onUserTurn([r.playbook], facts('short'), limits).fired).toEqual([])
    const out = engine.onUserTurn([r.playbook], facts('x'.repeat(80)), limits)
    expect(out.fired.map((f) => f.id)).toEqual(['long-message-breakdown'])
    expect(out.block).toContain('you also mentioned')
    expect(out.block).toContain('(goal: Answer the main point')
    const fired = events.find((e) => e.ev === 'trigger.fired')!
    expect(fired.data.why).toBe('when chars > tuning.longMessageChars and not fromSplit (chars 80, tuning.longMessageChars 50, fromSplit false)')
    expect(engine.onUserTurn([r.playbook], facts('x'.repeat(80), { fromSplit: true }), limits).fired).toEqual([])
  })

  it('matches phrases by meaningful words in any order', () => {
    const p = pb('push', 'triggers:\n  said: ["push the changes"]')
    const { engine } = setup()
    expect(engine.onUserTurn([p], facts('okay so can you push all my changes now'), limits).fired[0]!.why).toBe('said "push the changes"')
    expect(engine.onUserTurn([p], facts('push it'), limits).fired).toEqual([])
  })

  it('needs both the condition and a phrase when a playbook has both', () => {
    const p = pb('both', 'triggers:\n  when: "via == \\"typed\\""\n  said: ["push changes"]')
    const { engine } = setup()
    expect(engine.onUserTurn([p], facts('push changes'), limits).fired).toEqual([])
    expect(engine.onUserTurn([p], facts('push changes', { via: 'typed' }), limits).fired).toHaveLength(1)
  })

  it('traces a disabled playbook that would have fired, and does not inject it', () => {
    const p = pb('off', 'enabled: false\ntriggers:\n  when: "chars > 0"')
    const { engine, events } = setup()
    expect(engine.onUserTurn([p], facts('hello'), limits)).toEqual({ block: '', fired: [] })
    expect(events).toEqual([{ ev: 'trigger.dropped', data: { id: 'off', reason: 'disabled', title: 'off' } }])
  })

  it('holds a playbook back during its cooldown and past its per-conversation cap', () => {
    const cool = pb('cool', 'triggers:\n  when: "chars > 0"\ngates:\n  cooldownS: 10')
    const once = pb('once', 'triggers:\n  when: "chars > 0"\ngates:\n  maxPerSession: 1')
    const { engine, events, now } = setup()
    expect(engine.onUserTurn([cool, once], facts('a'), limits).fired.map((f) => f.id)).toEqual(['cool', 'once'])
    now.t = 5000
    expect(engine.onUserTurn([cool, once], facts('a'), limits).fired).toEqual([])
    expect(events.filter((e) => e.ev === 'trigger.dropped').map((e) => e.data.reason)).toEqual(['cooldown', 'session_cap'])
    now.t = 11_000
    expect(engine.onUserTurn([cool, once], facts('a'), limits).fired.map((f) => f.id)).toEqual(['cool'])
    engine.resetSession()
    expect(engine.onUserTurn([cool, once], facts('a'), limits).fired.map((f) => f.id)).toEqual(['cool', 'once'])
  })

  it('keeps the highest priorities when too many match, and drops the rest with reason cap', () => {
    const list = [pb('a', 'priority: low\ntriggers:\n  when: "chars > 0"'), pb('b', 'priority: critical\ntriggers:\n  when: "chars > 0"'), pb('c', 'priority: high\ntriggers:\n  when: "chars > 0"')]
    const { engine, events } = setup()
    const out = engine.onUserTurn(list, facts('hi'), { ...limits, maxInjected: 2 })
    expect(out.fired.map((f) => f.id)).toEqual(['b', 'c'])
    expect(events.find((e) => e.ev === 'trigger.dropped')!.data).toMatchObject({ id: 'a', reason: 'cap' })
  })

  it('ignores playbooks listening to other events, and cuts long instructions', () => {
    const other = pb('other', 'triggers:\n  events: [cc.finished]\n  when: "chars > 0"')
    const long = pb('long', 'triggers:\n  when: "chars > 0"', 'y'.repeat(500))
    const { engine } = setup()
    const out = engine.onUserTurn([other, long], facts('hi'), { ...limits, injectMaxChars: 100 })
    expect(out.fired.map((f) => f.id)).toEqual(['long'])
    expect(out.block).toContain(`${'y'.repeat(99)}…`)
    expect(out.block).not.toContain('y'.repeat(100))
  })

  it('accepts a prefix event', () => {
    const p = pb('prefix', 'triggers:\n  events: [turn.]\n  when: "chars > 0"')
    expect(setup().engine.onUserTurn([p], facts('hi'), limits).fired).toHaveLength(1)
  })
})
