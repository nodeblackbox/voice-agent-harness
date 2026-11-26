import { describe, expect, it } from 'vitest'
import { parsePlaybook } from './schema'
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
    const r = parsePlaybook('x', file('title: X\ngoal: Test.\ntriggers:\n  events: [cc.finished]\n  when: "session == 1"'))
    expect(r.ok).toBe(true)
    const text = r.warnings.map((w) => w.message).join('\n')
    expect(text).toMatch(/"cc.finished" does not fire/)
    expect(text).toMatch(/"session" is not a field/)
    const bare = parsePlaybook('y', file('title: Y\ngoal: Test.'))
    expect(bare.warnings[0]!.message).toMatch(/fires on every/)
  })

  it('needs the header, an instruction and a valid id; runbooks and canned mode are not in this version', () => {
    expect(parsePlaybook('x', 'no header').ok).toBe(false)
    expect(parsePlaybook('x', file('title: X\ngoal: Test.', '')).ok).toBe(false)
    expect(parsePlaybook('Bad Id', file('title: X\ngoal: Test.')).ok).toBe(false)
    const rb = parsePlaybook('x', file('kind: runbook\ntitle: X\ngoal: Test.'))
    expect(!rb.ok && rb.errors[0]!.message).toMatch(/later version/)
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
})
