import { describe, expect, it } from 'vitest'
import { parsePlaybook, usesJev } from './schema'
import { TEMPLATES } from './templates'

const file = (header: string, body = 'Do the thing.'): string => `---\n${header}\n---\n${body}\n`

describe('parsePlaybook', () => {
  it('parses every shipped template without errors or warnings', () => {
    for (const t of TEMPLATES) {
      const r = parsePlaybook(t.id, t.text)
      expect(r.ok, JSON.stringify(r)).toBe(true)
      expect(r.warnings).toEqual([])
    }
  })

  it('fills defaults', () => {
    const r = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  when: "chars > 5"'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.playbook).toMatchObject({ kind: 'playbook', enabled: true, priority: 'normal', mode: 'inject', gates: { cooldownS: 0, maxPerSession: null } })
    expect(r.playbook.triggers.events).toEqual(['turn.user'])
    expect(r.playbook.body).toBe('Do the thing.')
  })

  it('reports unknown fields and bad values on the right line', () => {
    const r = parsePlaybook('x', file('title: X\ngoal: Test.\nchance: 0.3\npriority: urgent'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toContainEqual({ line: 4, message: 'unknown field "chance"' })
    expect(r.errors.find((e) => e.message.startsWith('priority'))?.line).toBe(5)
  })

  it('reports a broken condition with its column', () => {
    const r = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  when: "chars >"'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatchObject({ line: 5 })
    expect(r.errors[0]!.message).toMatch(/triggers.when: .*column/)
  })

  it('refuses phrases with fewer than two meaningful words', () => {
    const r = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  said: ["go", "push the changes"]'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]!.message).toMatch(/"go" needs at least two/)
  })

  it('warns about events and fields that never fire, and about conditionless playbooks', () => {
    const r = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  events: [x.custom]\n  when: "session == 1"'))
    expect(r.ok).toBe(true)
    const text = r.warnings.map((w) => w.message).join('\n')
    expect(text).toMatch(/"x.custom" does not fire/)
    expect(text).toMatch(/"session" is not a field/)
    const bare = parsePlaybook('y', file('title: Y\ngoal: Test.'))
    expect(bare.warnings[0]!.message).toMatch(/fires on every/)
  })

  it('needs the header, an instruction and a valid id; a runbook needs steps; canned mode is not in this version', () => {
    expect(parsePlaybook('x', 'no header').ok).toBe(false)
    expect(parsePlaybook('x', file('title: X\ngoal: Test.', '')).ok).toBe(false)
    expect(parsePlaybook('Bad Id', file('title: X\ngoal: Test.')).ok).toBe(false)
    const rb = parsePlaybook('x', file('kind: runbook\ntitle: X\ngoal: Test.'))
    expect(!rb.ok && rb.errors[0]!.message).toMatch(/needs a list of steps/)
    expect(parsePlaybook('x', file('title: X\ngoal: Test.\nmode: canned')).ok).toBe(false)
  })

  it('reports YAML syntax errors', () => {
    const r = parsePlaybook('x', file('title: X\ngoal: [unclosed'))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]!.message).toMatch(/^YAML/)
  })

  it('accepts Windows line endings', () => {
    expect(parsePlaybook('x', '---\r\ntitle: X\r\ngoal: Test.\r\n---\r\nDo it.\r\n').ok).toBe(true)
  })

  it('lets only runbooks react to session and clock events, without said or ask, and knows their fields', () => {
    const pb = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  events: [cc.finished]'))
    expect(!pb.ok && pb.errors[0]!.message).toMatch(/a playbook shapes a reply.*make it kind: runbook/)
    const steps = 'steps:\n  - id: hi\n    do: say\n    text: hi'
    const said = parsePlaybook('x', file(`kind: runbook\ntitle: X\ngoal: Test.\ntriggers:\n  events: [cc.finished]\n  said: ["push it now"]\n${steps}`))
    expect(!said.ok && said.errors[0]!.message).toMatch(/said and ask read what the user said/)
    const ok = parsePlaybook('x', file(`kind: runbook\ntitle: X\ngoal: Test.\ntriggers:\n  events: [cc.finished]\n  when: "changedFiles > 0 and mode != \\"plan\\""\n${steps}`))
    expect(ok.ok).toBe(true)
    expect(ok.warnings).toEqual([])
    const clock = parsePlaybook('x', file(`kind: runbook\ntitle: X\ngoal: Test.\ntriggers:\n  events: [clock.tick]\n  when: "minute % 10 == 0 and sessionsWaiting > 0 and chars > 1"\n${steps}`))
    expect(clock.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/^"chars" is not a field this event has/)])
  })

  it('checks ask questions: both meanings or neither, a sane threshold, and a nudge to say `latest`', () => {
    const ok = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  said: ["push changes"]\n  ask:\n    question: "Is `latest` asking to push now?"\n    yes: "Asks to push"\n    no: "Anything else"'))
    expect(ok.ok && ok.playbook.triggers.ask).toEqual({ question: 'Is `latest` asking to push now?', yes: 'Asks to push', no: 'Anything else', min: 0.7 })
    expect(ok.warnings).toEqual([])
    const half = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  ask:\n    question: "Is `latest` asking to push now?"\n    yes: "Asks to push"'))
    expect(!half.ok && half.errors[0]!.message).toMatch(/both yes and no/)
    expect(parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  ask:\n    question: "Is it asking to push now?"\n    min: 0.3')).ok).toBe(false)
    const vague = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  ask:\n    question: "Is it asking to push now?"'))
    expect(vague.warnings.map((w) => w.message).join('\n')).toMatch(/`latest`[\s\S]*asked on every message/)
  })

  it('knows intent and intentP as fields, and which playbooks need Jev', () => {
    const r = parsePlaybook('x', file(`title: X\ngoal: Test.\ntriggers:\n  when: 'intent == "idea" and intentP > 0.6'`))
    expect(r.warnings).toEqual([])
    expect(r.ok && usesJev(r.playbook)).toBe(true)
    const plain = parsePlaybook('y', file('title: Y\ngoal: Test.\ntriggers:\n  when: "chars > 9"'))
    expect(plain.ok && usesJev(plain.playbook)).toBe(false)
  })
})


describe('the schedule trigger', () => {
  const rb = (triggers: string) => file(`kind: runbook\ntitle: X\ngoal: Test.\ntriggers:\n${triggers}\nsteps:\n  - { id: s, do: say, text: hi }`, '')
  it('parses a schedule with the schedule event', () => {
    const r = parsePlaybook('x', rb('  events: [schedule]\n  schedule: { at: ["09:00"], days: [mon, fri] }'))
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (r.ok) expect(r.playbook.triggers.schedule).toEqual({ at: ['09:00'], every: null, days: ['mon', 'fri'], from: null, until: null })
  })
  it('needs both the event and the schedule, and a time in it', () => {
    const msgs = (t: string) => { const r = parsePlaybook('x', rb(t)); return r.ok ? [] : r.errors.map((e) => e.message) }
    expect(msgs('  events: [schedule]').join()).toMatch(/needs triggers.schedule/)
    expect(msgs('  events: [cc.finished]\n  schedule: { at: ["09:00"] }').join()).toMatch(/only applies with the schedule event/)
    expect(msgs('  events: [schedule]\n  schedule: { days: [mon] }').join()).toMatch(/give at/)
    expect(msgs('  events: [schedule]\n  schedule: { at: ["25:00"] }').join()).toMatch(/HH:MM/)
    expect(msgs('  events: [schedule]\n  schedule: { every: 10, from: "18:00", until: "09:00" }').join()).toMatch(/until must be later/)
  })
  it('knows the fields of the new session events', () => {
    const r = parsePlaybook('x', rb('  events: [cc.context]\n  when: "percent >= 80 and previous < 80"'))
    expect(r.ok && r.warnings).toEqual([])
    const bad = parsePlaybook('x', rb('  events: [cc.error]\n  when: "percent > 1"'))
    expect(bad.warnings.map((w) => w.message).join()).toMatch(/"percent" is not a field/)
  })
})
