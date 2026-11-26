import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TEMPLATES } from '@core/playbooks/templates'
import { PlaybookService } from './playbooks'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function service() {
  const dir = mkdtempSync(join(tmpdir(), 'va-playbooks-'))
  dirs.push(dir)
  const traces: Array<{ ev: string; data: Record<string, unknown> }> = []
  const logs: string[] = []
  const s = new PlaybookService(join(dir, 'playbooks'), { log: (_l, m) => logs.push(m), trace: (ev, data) => traces.push({ ev, data }) })
  return { s, dir: join(dir, 'playbooks'), traces, logs }
}

describe('PlaybookService', () => {
  it('copies the templates and the guide in on first run, and loads them', () => {
    const { s, dir, traces } = service()
    s.seed()
    s.load()
    expect(existsSync(join(dir, '_guide.md'))).toBe(true)
    expect(s.playbooks().map((p) => p.id)).toEqual(TEMPLATES.map((t) => t.id).sort())
    expect(traces.at(-1)).toMatchObject({ ev: 'playbooks.loaded', data: { count: TEMPLATES.length, invalid: 0 } })
  })

  it('does not bring back a template the user deleted, and leaves edited ones alone', () => {
    const { s, dir } = service()
    s.seed()
    const id = TEMPLATES[0]!.id
    unlinkSync(join(dir, `${id}.md`))
    s.seed()
    expect(existsSync(join(dir, `${id}.md`))).toBe(false)
    expect(JSON.parse(readFileSync(join(dir, '_seeded.json'), 'utf8'))).toContain(id)
  })

  it('skips a broken file with its errors logged and traced, and keeps the rest', () => {
    const { s, dir, traces, logs } = service()
    s.seed()
    writeFileSync(join(dir, 'broken.md'), '---\ntitle: Broken\ngoal: x\nchance: 0.5\n---\nDo it.\n')
    s.load()
    expect(s.playbooks().map((p) => p.id)).not.toContain('broken')
    expect(s.playbooks()).toHaveLength(TEMPLATES.length)
    expect(s.invalid()).toEqual([{ id: 'broken', errors: [{ line: 4, message: 'unknown field "chance"' }], warnings: [] }])
    expect(logs.at(-1)).toBe('playbooks: broken.md not loaded: line 4: unknown field "chance"')
    expect(traces.find((t) => t.ev === 'playbooks.invalid')!.data).toEqual({ id: 'broken', errors: ['line 4: unknown field "chance"'] })
  })
})
