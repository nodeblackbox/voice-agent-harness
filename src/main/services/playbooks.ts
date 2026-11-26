// The playbooks folder: one .md file per playbook in `<userData>/playbooks` (docs/TRIGGERS.md). Templates
// are copied in once each (a list of what was copied is kept, so a deleted template stays deleted), files
// are re-read when they change on disk, and a file that does not parse is skipped with its errors logged
// and traced, never half-loaded. The Playbooks view edits the same files through this service: a save that
// does not parse is refused, so what is on disk always loads.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { PLAYBOOK_ID, parsePlaybook, setHeaderField, usesJev, type ParseIssue, type Playbook } from '@core/playbooks/schema'
import { GUIDE, TEMPLATES, type Template } from '@core/playbooks/templates'
import { runbookMermaid } from '@core/runbooks/steps'
import type { PlaybookCheck, PlaybookInfo, PlaybookSaveResult, PlaybooksState, TriggerActivity } from '@shared/types'

/** Trigger decisions kept for the Triggers overview. */
const ACTIVITY_CAP = 80

const SEEDED = '_seeded.json'
const GUIDE_FILE = '_guide.md'
const TRASH = '.trash'
/** Who made a change, for the trace and the commit message. */
type By = 'ui' | 'voice'

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
  /**
   * Runs git in the folder (args in, output out). Every change becomes a commit so it can be undone; without
   * git the folder still works, just without history. Injected for tests.
   */
  git?(args: string[]): Promise<string>
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
  private skipped = new Map<string, { count: number; last: { at: number; reason: string; by?: string } }>()
  private activity: TriggerActivity[] = []
  private watcher: FSWatcher | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** null until checked; false when git is missing or the folder could not become a repository. */
  private history: boolean | null = null
  /** Commits run one after another, so two quick saves cannot race. */
  private gitQueue: Promise<unknown> = Promise.resolve()
  /** Set up once: the folder becomes a repository (or is found not to be able to). Never queued behind a commit. */
  private historyReady: Promise<void> | null = null
  /** What the last load saw, so the watcher re-reading our own write does not log and refresh a second time. */
  private loadedSignature = ''

  constructor(
    readonly dir: string,
    private deps: PlaybookServiceDeps
  ) {}

  /** Create the folder, copy in templates not seen before, load everything and watch for edits. */
  start(): void {
    this.seed()
    this.load()
    void this.startHistory()
    try {
      // git's own files and the trash change on every save; only the playbook files matter here
      this.watcher = watch(this.dir, (_ev, name) => {
        if (name && /^(\.git|\.trash|_seeded\.json)/.test(String(name))) return
        this.scheduleLoad()
      })
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
  noteFired(id: string, title = id, why = '', by?: string): void {
    const at = (this.deps.now ?? Date.now)()
    const f = this.fired.get(id) ?? { count: 0, last: 0 }
    this.fired.set(id, { count: f.count + 1, last: at })
    this.log({ at, id, title, outcome: 'fired', detail: why, ...(by ? { by } : {}) })
  }

  /** From `trigger.dropped`: it matched, and a gate held it back. Switched-off ones are not logged (they would be on every message). */
  noteSkipped(id: string, title = id, reason = '', by?: string): void {
    if (reason === 'disabled') return
    const at = (this.deps.now ?? Date.now)()
    const s = this.skipped.get(id)
    this.skipped.set(id, { count: (s?.count ?? 0) + 1, last: { at, reason, ...(by ? { by } : {}) } })
    this.log({ at, id, title, outcome: 'skipped', detail: reason, ...(by ? { by } : {}) })
  }

  private log(a: TriggerActivity): void {
    this.activity.unshift(a)
    if (this.activity.length > ACTIVITY_CAP) this.activity.length = ACTIVITY_CAP
    this.deps.changed?.()
  }

  state(): PlaybooksState {
    return { dir: this.dir, playbooks: this.files.map((f) => this.info(f)), activity: [...this.activity], jev: this.deps.jev?.() ?? 'no_key' }
  }

  check(id: string, text: string): PlaybookCheck {
    const r = parsePlaybook(id, text)
    return { errors: r.ok ? [] : r.errors, warnings: r.warnings, ...(r.ok && r.playbook.runbook ? { diagram: runbookMermaid(r.playbook.runbook.steps) } : {}) }
  }

  /** Write a playbook. Nothing is written when it does not parse; a new id with `previousId` renames. */
  save(id: string, text: string, previousId?: string, by: By = 'ui'): PlaybookSaveResult {
    const r = parsePlaybook(id, text)
    if (!r.ok) return { ok: false, errors: r.errors }
    if (previousId && previousId !== id && existsSync(this.path(id))) return { ok: false, errors: [{ line: 0, message: `a playbook named "${id}" already exists` }] }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(id), text)
    if (previousId && previousId !== id && PLAYBOOK_ID.test(previousId) && existsSync(this.path(previousId))) unlinkSync(this.path(previousId))
    const action = previousId && previousId !== id ? 'rename' : 'save'
    this.deps.trace('playbooks.changed', { id, action, by })
    this.load()
    this.commit(action === 'rename' ? `Rename ${previousId} to ${id}` : `Save ${id}`, by)
    return { ok: true, id }
  }

  toggle(id: string, on: boolean, by: By = 'ui'): PlaybookSaveResult {
    const f = this.files.find((x) => x.id === id)
    if (!f) return { ok: false, errors: [{ line: 0, message: `no playbook named "${id}"` }] }
    const next = setHeaderField(f.source, 'enabled', on)
    if (next === null) return { ok: false, errors: [{ line: 1, message: 'the header could not be read, so it was not changed' }] }
    const r = this.write(id, next)
    if (r.ok) {
      this.deps.trace('playbooks.changed', { id, action: on ? 'on' : 'off', by })
      this.commit(`Switch ${id} ${on ? 'on' : 'off'}`, by)
    }
    return r
  }

  /** Moves the file to `.trash` (with a time stamp), so a delete can be undone by hand. */
  delete(id: string, by: By = 'ui'): void {
    if (!PLAYBOOK_ID.test(id) || !existsSync(this.path(id))) return
    const trash = join(this.dir, TRASH)
    mkdirSync(trash, { recursive: true })
    renameSync(this.path(id), join(trash, `${id}.${(this.deps.now ?? Date.now)()}.md`))
    this.deps.trace('playbooks.changed', { id, action: 'delete', by })
    this.load()
    this.commit(`Delete ${id}`, by)
  }

  /** Writes a file that parses, without a trace or a commit of its own (the caller does both). */
  private write(id: string, text: string): PlaybookSaveResult {
    const r = parsePlaybook(id, text)
    if (!r.ok) return { ok: false, errors: r.errors }
    writeFileSync(this.path(id), text)
    this.load()
    return { ok: true, id }
  }

  /** Whether changes are being kept in git (false until the folder's repository is ready, or without git). */
  hasHistory(): boolean {
    return this.history === true
  }

  /** Undo the last change: a new commit that reverses it, so the undo can itself be undone. */
  async undo(by: By = 'voice'): Promise<{ ok: boolean; message: string }> {
    await this.startHistory()
    if (!this.history) return { ok: false, message: 'There is no history to undo with: git is not available for the playbooks folder.' }
    await this.gitQueue
    try {
      const subject = (await this.git(['log', '-1', '--format=%s'])).trim()
      if (!subject || subject === 'Start the playbook history') return { ok: false, message: 'There is nothing to undo yet.' }
      await this.git(['revert', '--no-edit', 'HEAD'])
      this.load()
      const what = subject.replace(/ \((ui|voice)\)$/, '')
      this.deps.trace('playbooks.changed', { id: what, action: 'undo', by })
      return { ok: true, message: `Undid: ${what}.` }
    } catch (e) {
      this.deps.log('warn', `playbooks: undo failed: ${(e as Error).message}`)
      return { ok: false, message: `The undo failed: ${(e as Error).message.split('\n')[0]}` }
    }
  }

  private git(args: string[]): Promise<string> {
    if (this.deps.git) return this.deps.git(args)
    // a fixed identity for these commits, so nothing in the user's git config is needed or touched
    const full = ['-c', 'user.name=Voice Agent', '-c', 'user.email=playbooks@voice-agent.local', '-c', 'core.autocrlf=false', ...args]
    return new Promise((resolve, reject) =>
      execFile('git', full, { cwd: this.dir, windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)))
    )
  }

  private startHistory(): Promise<void> {
    this.historyReady ??= (async () => {
      try {
        if (!existsSync(join(this.dir, '.git'))) {
          await this.git(['init', '-q'])
          writeFileSync(join(this.dir, '.gitignore'), `${TRASH}/\n`)
          await this.git(['add', '-A'])
          await this.git(['commit', '-q', '-m', 'Start the playbook history'])
        }
        this.history = true
      } catch (e) {
        this.history = false
        this.deps.log('warn', `playbooks: no history for undo (git: ${(e as Error).message.split('\n')[0]})`)
      }
    })()
    return this.historyReady
  }

  /**
   * One commit per change, in order; failures are logged, never thrown at the user. Git reads the files when the
   * commit runs, so two changes in the same instant land in one commit (and one undo); clicks and voice requests
   * are seconds apart.
   */
  private commit(message: string, by: By): void {
    this.gitQueue = this.gitQueue
      .then(async () => {
        await this.startHistory()
        if (!this.history) return
        await this.git(['add', '-A'])
        const status = await this.git(['status', '--porcelain'])
        if (status.trim()) await this.git(['commit', '-q', '-m', `${message} (${by})`])
      })
      .catch((e: Error) => this.deps.log('warn', `playbooks: could not record "${message}": ${e.message.split('\n')[0]}`))
  }

  /** For tests: wait until every queued commit has run. */
  async settled(): Promise<void> {
    await this.startHistory()
    await this.gitQueue
  }

  private path(id: string): string {
    if (!PLAYBOOK_ID.test(id)) throw new Error(`"${id}" is not a valid playbook name`)
    return join(this.dir, `${id}.md`)
  }

  private info(f: Loaded): PlaybookInfo {
    const p = f.playbook
    const stats = this.fired.get(f.id)
    const skip = this.skipped.get(f.id)
    const base = { id: f.id, source: f.source, ok: !!p, errors: f.errors, warnings: f.warnings, firedCount: stats?.count ?? 0, lastFiredAt: stats?.last ?? null, skippedCount: skip?.count ?? 0, lastSkip: skip?.last ?? null }
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
      schedule: p.triggers.schedule,
      usesJev: usesJev(p),
      kind: p.kind,
      diagram: p.runbook ? runbookMermaid(p.runbook.steps) : undefined,
      stepCount: p.runbook?.steps.length
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
    const signature = JSON.stringify(files.map((f) => [f.id, f.source]))
    if (signature === this.loadedSignature) return
    this.loadedSignature = signature
    const list = this.playbooks()
    this.deps.trace('playbooks.loaded', { count: list.length, enabled: list.filter((p) => p.enabled).length, invalid: files.filter((f) => !f.playbook).length, ids: list.map((p) => p.id) })
    this.deps.changed?.()
  }
}
