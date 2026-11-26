// The playbooks folder: one .md file per playbook in `<userData>/playbooks` (docs/TRIGGERS.md). Templates
// are copied in once each (a list of what was copied is kept, so a deleted template stays deleted), files
// are re-read when they change on disk, and a file that does not parse is skipped with its errors logged
// and traced, never half-loaded.

import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { parsePlaybook, type ParseIssue, type Playbook } from '@core/playbooks/schema'
import { GUIDE, TEMPLATES, type Template } from '@core/playbooks/templates'

const SEEDED = '_seeded.json'
const GUIDE_FILE = '_guide.md'

export interface PlaybookProblem {
  id: string
  errors: ParseIssue[]
  warnings: ParseIssue[]
}

export interface PlaybookServiceDeps {
  log(level: 'info' | 'warn', msg: string): void
  trace(ev: string, data: Record<string, unknown>): void
  templates?: Template[]
}

export class PlaybookService {
  private list: Playbook[] = []
  private problems: PlaybookProblem[] = []
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
    return this.list
  }

  invalid(): PlaybookProblem[] {
    return this.problems
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
    const list: Playbook[] = []
    const problems: PlaybookProblem[] = []
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
      if (r.ok) list.push(r.playbook)
      if (!r.ok || r.warnings.length) problems.push({ id, errors: r.ok ? [] : r.errors, warnings: r.warnings })
      if (!r.ok) {
        const first = r.errors[0]!
        this.deps.log('warn', `playbooks: ${name} not loaded: ${first.line ? `line ${first.line}: ` : ''}${first.message}${r.errors.length > 1 ? ` (and ${r.errors.length - 1} more)` : ''}`)
        this.deps.trace('playbooks.invalid', { id, errors: r.errors.map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)) })
      }
    }
    this.list = list
    this.problems = problems
    this.deps.trace('playbooks.loaded', { count: list.length, enabled: list.filter((p) => p.enabled).length, invalid: problems.filter((p) => p.errors.length).length, ids: list.map((p) => p.id) })
  }
}
