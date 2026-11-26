import { describe, expect, it } from 'vitest'
import { PlaybookEngine, planJev, type EngineLimits, type TurnFacts } from './engine'
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
    const other = pb('other', 'triggers:\n  events: [x.custom]\n  when: "chars > 0"')
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

  it('matches intent conditions and ask questions only with Jev answers, and says how sure Jev was', () => {
    const idea = pb('idea', `triggers:\n  when: 'intent == "idea"'`)
    const push = pb('push', 'triggers:\n  said: ["push changes"]\n  ask:\n    question: "Is `latest` asking to push changes now?"\n    min: 0.8')
    const { engine } = setup()
    expect(engine.onUserTurn([idea, push], facts('push changes'), limits).fired).toEqual([])
    const out = engine.onUserTurn([idea, push], facts('push changes'), limits, { intent: 'idea', intentP: 0.74, asks: { push: 0.91 } })
    expect(out.fired.map((f) => [f.id, f.why])).toEqual([
      ['idea', 'when intent == "idea" (intent "idea" at 0.74)'],
      ['push', 'said "push changes" and Jev: yes to "Is `latest` asking to push changes now?" (0.91)']
    ])
    expect(engine.onUserTurn([push], facts('push changes'), limits, { intent: null, intentP: null, asks: { push: 0.79 } }).fired).toEqual([])
  })
})

describe('runbooks in the engine', () => {
  const rb = (id: string, priority: string) => {
    const r = parsePlaybook(id, `---\nkind: runbook\ntitle: ${id}\ngoal: Does ${id}.\npriority: ${priority}\nack: on it\ntriggers:\n  when: "chars > 0"\nsteps:\n  - id: hi\n    do: say\n    text: hi\n---\n`)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return r.playbook
  }

  it('starts one runbook per message, the highest priority, and the reply only mentions it', () => {
    const { engine, events } = setup()
    const out = engine.onUserTurn([rb('low-job', 'low'), rb('high-job', 'high'), pb('plain', 'triggers:\n  when: "chars > 0"')], facts('hello'), limits)
    expect(out.fired.map((f) => [f.id, f.kind])).toEqual([
      ['high-job', 'runbook'],
      ['plain', 'playbook']
    ])
    expect(events.find((e) => e.ev === 'trigger.dropped')!.data).toMatchObject({ id: 'low-job', reason: 'one_runbook' })
    expect(out.block).toContain('"high-job" has started in the background for this message (its job: Does high-job). It is already handled: do not do that part yourself, and do not start, queue, save or set up anything for it. Mention it in a few words, in your own way, like: "on it"')
    expect(out.block).not.toContain('Notes')
  })
})

describe('PlaybookEngine.onEvent', () => {
  const rb = (id: string, triggers: string, extra = '') => {
    const r = parsePlaybook(id, `---\nkind: runbook\ntitle: ${id}\ngoal: x.\n${extra}triggers:\n${triggers}\nsteps:\n  - id: hi\n    do: say\n    text: hi\n---\n`)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return r.playbook
  }

  it('fires the highest-priority runbook listening to the event whose condition holds, and only runbooks', () => {
    const { engine, events } = setup()
    const list = [
      rb('push', '  events: [cc.finished]\n  when: "changedFiles > 0"'),
      rb('note', '  events: [cc.]', 'priority: high\n'),
      rb('clock', '  events: [clock.tick]'),
      pb('plain', 'triggers:\n  when: "chars > 0"')
    ]
    expect(engine.onEvent(list, 'cc.finished', { changedFiles: 2 }, {})).toMatchObject({ id: 'note', kind: 'runbook', why: 'every cc.finished' })
    expect(events.filter((e) => e.ev === 'trigger.dropped').map((e) => e.data)).toEqual([{ id: 'push', reason: 'one_runbook', title: 'push', by: 'cc.finished' }])
    expect(engine.onEvent([list[0]!], 'cc.finished', { changedFiles: 0 }, {})).toBeNull()
    expect(engine.onEvent(list, 'turn.user', { text: 'hi' }, {})).toBeNull()
  })

  it('does not log a switched-off clock runbook every minute', () => {
    const { engine, events } = setup()
    expect(engine.onEvent([{ ...rb('clock', '  events: [clock.tick]'), enabled: false }], 'clock.tick', { minute: 1 }, {})).toBeNull()
    expect(events).toEqual([])
  })
})

describe('planJev', () => {
  const idea = pb('idea', `triggers:\n  when: 'intent == "idea"'`)
  const push = pb('push', 'triggers:\n  said: ["push changes"]\n  ask:\n    question: "Is `latest` asking to push changes now?"')
  const longAsk = pb('long-ask', 'triggers:\n  when: "chars > 20"\n  ask:\n    question: "Is `latest` a list of several unrelated topics?"')
  const plain = pb('plain', 'triggers:\n  when: "chars > 0"')

  it('asks nothing when no enabled playbook needs Jev', () => {
    expect(planJev([plain, { ...idea, enabled: false }], facts('hello'), {})).toEqual({ root: false, asks: [] })
  })

  it('asks the root question for intent conditions, and a playbook question only when the rest of it matched', () => {
    const plan = planJev([idea, push, longAsk, plain], facts('hello there'), {})
    expect(plan.root).toBe(true)
    expect(plan.asks).toEqual([])
    const plan2 = planJev([idea, push, longAsk], facts('please push changes, all of them, right now'), {})
    expect(plan2.asks.map((p) => p.id)).toEqual(['push', 'long-ask'])
  })
})

