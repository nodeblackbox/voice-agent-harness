import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TEMPLATES } from '@core/playbooks/templates'
import { PlaybookService } from './playbooks'

const dirs: string[] = []
const services: PlaybookService[] = []
afterEach(async () => {
  // git may still be committing in the folder; let it finish before the folder goes
  await Promise.all(services.splice(0).map((s) => s.settled().catch(() => undefined)))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function service() {
  const dir = mkdtempSync(join(tmpdir(), 'va-playbooks-'))
  dirs.push(dir)
  const traces: Array<{ ev: string; data: Record<string, unknown> }> = []
  const logs: string[] = []
  const s = new PlaybookService(join(dir, 'playbooks'), { log: (_l, m) => logs.push(m), trace: (ev, data) => traces.push({ ev, data }) })
  services.push(s)
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

  it('saves only files that parse, renames, toggles without rewriting the rest, and moves deletes to .trash', () => {
    const { s, dir } = service()
    s.seed()
    s.load()
    const good = '---\ntitle: Push\ngoal: Push after work.\n# keep this comment\ntriggers:\n  said: ["push the changes"]\n---\nOffer to push.\n'
    expect(s.save('push', '---\ntitle: Push\n---\nx\n')).toMatchObject({ ok: false })
    expect(existsSync(join(dir, 'push.md'))).toBe(false)
    expect(s.save('push', good)).toEqual({ ok: true, id: 'push' })
    expect(s.state().playbooks.find((p) => p.id === 'push')).toMatchObject({ ok: true, title: 'Push', enabled: true, said: ['push the changes'], firedCount: 0 })

    expect(s.toggle('push', false)).toEqual({ ok: true, id: 'push' })
    const after = readFileSync(join(dir, 'push.md'), 'utf8')
    expect(after).toContain('enabled: false')
    expect(after).toContain('# keep this comment')
    expect(after.endsWith('Offer to push.\n')).toBe(true)
    expect(s.playbooks().find((p) => p.id === 'push')!.enabled).toBe(false)

    expect(s.save('push-it', after, 'push')).toEqual({ ok: true, id: 'push-it' })
    expect(existsSync(join(dir, 'push.md'))).toBe(false)
    expect(s.save(TEMPLATES[0]!.id, after, 'push-it')).toMatchObject({ ok: false, errors: [{ message: expect.stringContaining('already exists') }] })

    s.delete('push-it')
    expect(existsSync(join(dir, 'push-it.md'))).toBe(false)
    expect(s.playbooks().map((p) => p.id)).not.toContain('push-it')
    expect(readFileSync(join(dir, '.trash', readdirSync(join(dir, '.trash'))[0]!), 'utf8')).toBe(after)
  })

  it('counts firings for the view and lists broken files with their text', () => {
    const { s, dir } = service()
    s.seed()
    writeFileSync(join(dir, 'broken.md'), 'no header')
    s.load()
    s.noteFired(TEMPLATES[0]!.id)
    s.noteFired(TEMPLATES[0]!.id)
    const st = s.state()
    expect(st.dir).toBe(dir)
    expect(st.playbooks.find((p) => p.id === TEMPLATES[0]!.id)).toMatchObject({ firedCount: 2 })
    expect(st.playbooks.find((p) => p.id === 'broken')).toMatchObject({ ok: false, source: 'no header', firedCount: 0 })
  })

  describe('history', () => {
    const hasGit = (() => {
      try {
        execFileSync('git', ['--version'], { stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    })()
    const log = (dir: string) => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim().split('\n')
    const GOOD = '---\ntitle: Push\ngoal: Push after work.\ntriggers:\n  said: ["push the changes"]\n---\nOffer to push.\n'

    it.skipIf(!hasGit)('commits every change, and undo reverses the last one, a delete included', async () => {
      const { s, dir } = service()
      s.seed()
      s.load()
      // as start() does: the history exists before the first change
      await s.settled()
      s.save('push', GOOD, undefined, 'voice')
      await s.settled()
      s.toggle('push', false)
      await s.settled()
      expect(log(dir)).toEqual(['Switch push off (ui)', 'Save push (voice)', 'Start the playbook history'])
      expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.trash/\n')

      expect(await s.undo()).toEqual({ ok: true, message: 'Undid: Switch push off.' })
      expect(s.playbooks().find((p) => p.id === 'push')!.enabled).toBe(true)

      s.delete('push', 'voice')
      await s.settled()
      expect(existsSync(join(dir, 'push.md'))).toBe(false)
      expect((await s.undo()).ok).toBe(true)
      expect(readFileSync(join(dir, 'push.md'), 'utf8')).toBe(GOOD)
      expect(s.playbooks().map((p) => p.id)).toContain('push')
    }, 30_000)

    it('works without git: changes still save, and undo says there is no history', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'va-playbooks-nogit-'))
      dirs.push(dir)
      const logs: string[] = []
      const s = new PlaybookService(join(dir, 'playbooks'), { log: (_l, m) => logs.push(m), trace: () => undefined, git: async () => Promise.reject(new Error('git not found')) })
      s.seed()
      s.load()
      expect(s.save('push', GOOD)).toEqual({ ok: true, id: 'push' })
      await s.settled()
      expect(s.hasHistory()).toBe(false)
      expect(await s.undo()).toEqual({ ok: false, message: expect.stringContaining('no history') })
      expect(logs.some((l) => l.includes('no history for undo'))).toBe(true)
    })
  })
})

