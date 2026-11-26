// The playbooks folder: one .md file per playbook in `<userData>/playbooks` (docs/TRIGGERS.md). Templates
// are copied in once each (a list of what was copied is kept, so a deleted template stays deleted), files
// are re-read when they change on disk, and a file that does not parse is skipped with its errors logged
// and traced, never half-loaded. The Playbooks view edits the same files through this service: a save that
// does not parse is refused, so what is on disk always loads.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { PLAYBOOK_ID, parsePlaybook, setHeaderField, usesJev, type ParseIssue, type Playbook } from '@core/playbooks/schema'
import { GUIDE, TEMPLATES, type Template } from '@core/playbooks/templates'
import type { PlaybookCheck, PlaybookInfo, PlaybookSaveResult, PlaybooksState } from '@shared/types'

const SEEDED = '_seeded.json'
const GUIDE_FILE = '_guide.md'
const TRASH = '.trash'

export interface PlaybookProblem {
  id: string
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

export interface PlaybookServiceDeps {
  log(level: 'info' | 'warn', msg: string): void
  trace(ev: string, data: Record<string, unknown>): void
  /** Told after every (re)load, e.g. to refresh the Playbooks view. */
  changed?(): void
  templates?: Template[]
  now?(): number
  /** Whether Jev can answer: a key is set and it is switched on. */
  jev?(): 'ready' | 'no_key' | 'off'
}

interface Loaded {
  id: string
  source: string
  playbook: Playbook | null
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

export class PlaybookService {
  private files: Loaded[] = []
  private fired = new Map<string, { count: number; last: number }>()
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly dir: string,
    private deps: PlaybookServiceDeps
  ) {}

  /** Create the folder, copy in templates not seen before, load everything and watch for edits. */
  start(): void {
    this.seed()
    this.load()
    try {
      this.watcher = watch(this.dir, () => this.scheduleLoad())
      this.watcher.on('error', (e) => this.deps.log('warn', `playbooks: watching the folder stopped: ${e.message}`))
    } catch (e) {
      this.deps.log('warn', `playbooks: cannot watch the folder, edits apply on the next launch: ${(e as Error).message}`)
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.timer) clearTimeout(this.timer)
  }

  playbooks(): Playbook[] {
    return this.files.flatMap((f) => (f.playbook ? [f.playbook] : []))
  }

  invalid(): PlaybookProblem[] {
    return this.files.filter((f) => f.errors.length || f.warnings.length).map(({ id, errors, warnings }) => ({ id, errors, warnings }))
  }

  /** Counted from `trigger.fired`, for "fired 3 times, last 2 min ago" in the view. Per app run. */
  noteFired(id: string): void {
    const f = this.fired.get(id) ?? { count: 0, last: 0 }
    this.fired.set(id, { count: f.count + 1, last: (this.deps.now ?? Date.now)() })
    this.deps.changed?.()
  }

  state(): PlaybooksState {
    return { dir: this.dir, playbooks: this.files.map((f) => this.info(f)), jev: this.deps.jev?.() ?? 'no_key' }
  }

  check(id: string, text: string): PlaybookCheck {
    const r = parsePlaybook(id, text)
    return { errors: r.ok ? [] : r.errors, warnings: r.warnings }
  }

  /** Write a playbook. Nothing is written when it does not parse; a new id with `previousId` renames. */
  save(id: string, text: string, previousId?: string): PlaybookSaveResult {
    const r = parsePlaybook(id, text)
    if (!r.ok) return { ok: false, errors: r.errors }
    if (previousId && previousId !== id && existsSync(this.path(id))) return { ok: false, errors: [{ line: 0, message: `a playbook named "${id}" already exists` }] }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(id), text)
    if (previousId && previousId !== id && PLAYBOOK_ID.test(previousId) && existsSync(this.path(previousId))) unlinkSync(this.path(previousId))
    this.deps.trace('playbooks.changed', { id, action: previousId && previousId !== id ? 'rename' : 'save', by: 'ui' })
    this.load()
    return { ok: true, id }
  }

  toggle(id: string, on: boolean): PlaybookSaveResult {
    const f = this.files.find((x) => x.id === id)
    if (!f) return { ok: false, errors: [{ line: 0, message: `no playbook named "${id}"` }] }
    const next = setHeaderField(f.source, 'enabled', on)
    if (next === null) return { ok: false, errors: [{ line: 1, message: 'the header could not be read, so it was not changed' }] }
    const r = this.save(id, next)
    if (r.ok) this.deps.trace('playbooks.changed', { id, action: on ? 'on' : 'off', by: 'ui' })
    return r
  }

  /** Moves the file to `.trash` (with a time stamp), so a delete can be undone by hand. */
  delete(id: string): void {
    if (!PLAYBOOK_ID.test(id) || !existsSync(this.path(id))) return
    const trash = join(this.dir, TRASH)
    mkdirSync(trash, { recursive: true })
    renameSync(this.path(id), join(trash, `${id}.${(this.deps.now ?? Date.now)()}.md`))
    this.deps.trace('playbooks.changed', { id, action: 'delete', by: 'ui' })
    this.load()
  }

  private path(id: string): string {
    if (!PLAYBOOK_ID.test(id)) throw new Error(`"${id}" is not a valid playbook name`)
    return join(this.dir, `${id}.md`)
  }

  private info(f: Loaded): PlaybookInfo {
    const p = f.playbook
    const stats = this.fired.get(f.id)
    const base = { id: f.id, source: f.source, ok: !!p, errors: f.errors, warnings: f.warnings, firedCount: stats?.count ?? 0, lastFiredAt: stats?.last ?? null }
    if (!p) return base
    return {
      ...base,
      title: p.title,
      goal: p.goal,
      enabled: p.enabled,
      priority: p.priority,
      events: p.triggers.events,
      when: p.triggers.when,
      said: p.triggers.said,
      cooldownS: p.gates.cooldownS,
      maxPerSession: p.gates.maxPerSession,
      tags: p.tags,
      ask: p.triggers.ask?.question ?? null,
      usesJev: usesJev(p)
    }
  }

  private scheduleLoad(): void {
    if (this.timer) clearTimeout(this.timer)
    // editors write in several steps; read once they are done
    this.timer = setTimeout(() => this.load(), 250)
    this.timer.unref?.()
  }

  seed(): void {
    mkdirSync(this.dir, { recursive: true })
    const seededPath = join(this.dir, SEEDED)
    let seeded: string[] = []
    try {
      if (existsSync(seededPath)) seeded = JSON.parse(readFileSync(seededPath, 'utf8')) as string[]
    } catch {
      seeded = []
    }
    const templates = this.deps.templates ?? TEMPLATES
    const added: string[] = []
    for (const t of templates) {
      if (seeded.includes(t.id)) continue
      const path = join(this.dir, `${t.id}.md`)
      if (!existsSync(path)) {
        writeFileSync(path, t.text)
        added.push(t.id)
      }
      seeded.push(t.id)
    }
    if (!existsSync(join(this.dir, GUIDE_FILE))) writeFileSync(join(this.dir, GUIDE_FILE), GUIDE)
    writeFileSync(seededPath, `${JSON.stringify(seeded, null, 2)}\n`)
    if (added.length) this.deps.log('info', `playbooks: added templates ${added.join(', ')}`)
  }

  load(): void {
    const files: Loaded[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.md') && !n.startsWith('_'))
    } catch (e) {
      this.deps.log('warn', `playbooks: cannot read the folder: ${(e as Error).message}`)
    }
    for (const name of names.sort()) {
      const id = name.slice(0, -3)
      let text: string
      try {
        text = readFileSync(join(this.dir, name), 'utf8')
      } catch (e) {
        this.deps.log('warn', `playbooks: cannot read ${name}: ${(e as Error).message}`)
        continue
      }
      const r = parsePlaybook(id, text)
      files.push({ id, source: text, playbook: r.ok ? r.playbook : null, errors: r.ok ? [] : r.errors, warnings: r.warnings })
      if (!r.ok) {
        const first = r.errors[0]!
        this.deps.log('warn', `playbooks: ${name} not loaded: ${first.line ? `line ${first.line}: ` : ''}${first.message}${r.errors.length > 1 ? ` (and ${r.errors.length - 1} more)` : ''}`)
        this.deps.trace('playbooks.invalid', { id, errors: r.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)) })
      }
    }
    this.files = files
    const list = this.playbooks()
    this.deps.trace('playbooks.loaded', { count: list.length, enabled: list.filter((p) => p.enabled).length, invalid: files.filter((f) => !f.playbook).length, ids: list.map((p) => p.id) })
    this.deps.changed?.()
  }
}
