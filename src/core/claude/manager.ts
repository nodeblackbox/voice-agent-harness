/**
 * Runs several Claude Code sessions at once and exposes a small, voice-friendly control surface:
 * start / send (queue) / interrupt / stop / resume / answer a pending question or approval.
 * Electron-free; the SDK is injected (`CcSdk`) so everything is testable with a scripted fake.
 *
 * Lab-verified behaviour this relies on (lab/claude-sdk/FINDINGS.md):
 *  - interrupt() ends the turn (`terminal_reason` aborted_*), keeps the stream usable and the session resumable
 *  - AskUserQuestion arrives in canUseTool and is answered with updatedInput.answers
 *  - a PreToolUse deny hook is the hard gate (here: `gate`, backed by fence.ts)
 */
import fs from 'node:fs'
import path from 'node:path'
import { digest } from './digest'
import { historyEvents, messageEvents } from './events'
import { checkToolUse } from './fence'
import { listWorkspace, readWorkspaceFile } from './files'
import { Pushable } from './pushable'
import type {
  CcAnswer, CcEvent, CcExternal, CcFile, CcFileContent, CcHistory, CcManagerEvent, CcPending, CcPermissionResult, CcQuestion, CcResult, CcRun, CcSdk, CcSession,
} from './types'

export interface ManagerDeps {
  sdk: CcSdk
  /** The machine's saved Claude Code sessions (CLI, IDE, other apps), for browsing and attaching. */
  history?: CcHistory
  /** Every session workspace lives directly under this folder. */
  workspaceRoot: string
  model?: string
  maxSessions?: number
  /** Ask by voice before running any shell command (default true). */
  approveShell?: boolean
  /** Live overrides of the four fields above, read on every use so Settings changes apply at once. */
  config?: () => Partial<Pick<ManagerDeps, 'workspaceRoot' | 'model' | 'maxSessions' | 'approveShell'>>
  eventBuffer?: number
  now?: () => number
  mkdir?: (dir: string) => void
  /** Called with a snapshot whenever a session changes, for persistence. */
  persist?: (sessions: CcSession[]) => void
}

interface Rt {
  s: CcSession
  events: CcEvent[]
  input?: Pushable<unknown>
  run?: CcRun
  resolve?: (r: CcPermissionResult) => void
  pendingInput?: Record<string, unknown>
  /** Prompt to send as soon as an in-flight interrupt lands (`send(..., {now:true})`). */
  redirect?: string
  lastText: string
}


const SHELL = new Set(['Bash', 'PowerShell'])
const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
const userMsg = (text: string, sessionId = '') => ({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId })

export class ClaudeSessionManager {
  private rts = new Map<string, Rt>()
  private listeners = new Set<(e: CcManagerEvent) => void>()
  private seq = 0

  constructor(private d: ManagerDeps) {}

  private get cfg() {
    return { ...this.d, ...(this.d.config?.() ?? {}) }
  }

  on(fn: (e: CcManagerEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // ---- queries ----
  list(): CcSession[] { return [...this.rts.values()].map((r) => this.snap(r)) }
  get(id: string): CcSession | undefined { const r = this.rts.get(id); return r && this.snap(r) }
  events(id: string, n = 40): CcEvent[] { return (this.rts.get(id)?.events ?? []).slice(-n) }
  digest(id: string): string { return digest(this.rts.get(id)?.events ?? []) }
  files(id: string): CcFile[] { const r = this.rts.get(id); return r ? listWorkspace(r.s.workspace) : [] }
  readFile(id: string, rel: string): CcFileContent | { error: string } {
    const r = this.rts.get(id)
    return r ? readWorkspaceFile(r.s.workspace, rel) : { error: 'No such session.' }
  }

  /** Voice-friendly lookup: id, exact name, slug, or a unique case-insensitive partial name. */
  find(ref: string | undefined): CcResult<{ session: CcSession }> {
    ref = ref ?? ''
    const q = ref.trim().toLowerCase()
    const all = this.list()
    if (!q) return all.length === 1 ? { ok: true, session: all[0]! } : { ok: false, error: all.length ? 'Which session? ' + all.map((s) => s.name).join(', ') : 'There are no sessions.' }
    const exact = all.find((s) => s.id === ref || s.name.toLowerCase() === q || slugify(s.name) === slugify(q))
    if (exact) return { ok: true, session: exact }
    const part = all.filter((s) => s.name.toLowerCase().includes(q) || slugify(s.name).includes(slugify(q)))
    if (part.length === 1) return { ok: true, session: part[0]! }
    return { ok: false, error: part.length ? `"${ref}" matches ${part.map((s) => s.name).join(' and ')}` : `No session called "${ref}".` }
  }

  // ---- lifecycle ----
  /** Load persisted sessions. Nothing is running after a restart; the next send resumes by SDK session id. */
  restore(list: CcSession[]): void {
    for (const s of list) {
      this.rts.set(s.id, { s: { ...s, status: s.status === 'error' ? 'error' : 'stopped', pending: undefined, queued: [...s.queued] }, events: [], lastText: '' })
    }
  }

  start(name: string, firstPrompt?: string): CcResult<{ session: CcSession }> {
    const max = this.cfg.maxSessions ?? 4
    if (this.rts.size >= max) return { ok: false, error: `Already at the limit of ${max} sessions.` }
    let slug = slugify(name)
    const taken = new Set([...this.rts.values()].map((r) => path.basename(r.s.workspace)))
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(name)}-${i}`
    const workspace = path.join(this.cfg.workspaceRoot, slug)
    const t = this.now()
    const s: CcSession = {
      id: `cc${++this.seq}-${t.toString(36)}`, name: name.trim() || slug, workspace, status: 'idle',
      queued: [], lastSummary: '', costUsd: 0, turns: 0, createdAt: t, updatedAt: t,
    }
    try { (this.d.mkdir ?? ((p) => fs.mkdirSync(p, { recursive: true })))(workspace) } catch (e) {
      return { ok: false, error: `Could not create the workspace: ${(e as Error).message}` }
    }
    this.rts.set(s.id, { s, events: [], lastText: '' })
    this.changed(this.rts.get(s.id)!)
    if (firstPrompt?.trim()) this.send(s.id, firstPrompt)
    return { ok: true, session: this.get(s.id)! }
  }

  /** Send a prompt. If the session is busy it is queued (stacked); `now` interrupts and redirects instead. */
  send(id: string, text: string, opts: { now?: boolean } = {}): CcResult<{ queued: boolean }> {
    const r = this.rts.get(id)
    if (!r) return { ok: false, error: 'No such session.' }
    if (!text.trim()) return { ok: false, error: 'Empty prompt.' }
    const busy = r.s.status === 'running' || r.s.status === 'needs_input' || r.s.status === 'needs_permission'
    if (busy && opts.now) {
      r.redirect = text
      void this.interrupt(id)
      return { ok: true, queued: false }
    }
    if (busy) {
      r.s.queued.push(text)
      this.changed(r)
      return { ok: true, queued: true }
    }
    this.dispatch(r, text)
    return { ok: true, queued: false }
  }

  async interrupt(id: string, opts: { clearQueue?: boolean } = {}): Promise<CcResult> {
    const r = this.rts.get(id)
    if (!r) return { ok: false, error: 'No such session.' }
    if (opts.clearQueue) r.s.queued = []
    this.settle(r, { behavior: 'deny', message: 'The user interrupted.', interrupt: true })
    if (!r.run || r.s.status === 'idle' || r.s.status === 'stopped') return { ok: true }
    this.log(r, 'interrupt', 'Interrupted by the user.')
    try { await r.run.interrupt() } catch (e) { return { ok: false, error: (e as Error).message } }
    return { ok: true }
  }

  async stop(id: string): Promise<CcResult> {
    const r = this.rts.get(id)
    if (!r) return { ok: false, error: 'No such session.' }
    r.s.queued = []
    r.redirect = undefined
    await this.interrupt(id)
    r.input?.close()
    r.run?.close()
    r.run = undefined
    r.input = undefined
    r.s.status = 'stopped'
    this.changed(r)
    return { ok: true }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.rts.keys()].map((id) => this.stop(id)))
  }

  /** Answer the session's pending AskUserQuestion or approval. */
  answer(id: string, a: CcAnswer): CcResult<{ said: string }> {
    const r = this.rts.get(id)
    const p = r?.s.pending
    if (!r || !p || !r.resolve) return { ok: false, error: 'Nothing is waiting for an answer.' }

    if (p.kind === 'permission') {
      if (a.kind === 'allow') { this.settle(r, { behavior: 'allow', updatedInput: r.pendingInput ?? {} }); return { ok: true, said: 'approved' } }
      if (a.kind === 'deny') { this.settle(r, { behavior: 'deny', message: a.reason ?? 'The user said no.' }); return { ok: true, said: 'denied' } }
      return { ok: false, error: 'That is a yes/no approval.' }
    }

    // Question
    const qs = p.questions
    const first = qs[0]
    const answers: Record<string, string> = {}
    if (a.kind === 'choice') {
      const labelOf = (q: CcQuestion, n: number) => q.options[n - 1]?.label
      if (qs.length === 1 && first) {
        const labels = a.choices.map((n) => labelOf(first, n))
        if (!labels.length || labels.some((l) => !l)) return { ok: false, error: `Pick a number from 1 to ${first.options.length}.` }
        if (labels.length > 1 && !first.multiSelect) return { ok: false, error: 'Only one option can be chosen.' }
        answers[first.question] = labels.join(', ')
      } else {
        if (a.choices.length !== qs.length) return { ok: false, error: `There are ${qs.length} questions; give one choice for each.` }
        for (const [i, q] of qs.entries()) {
          const l = labelOf(q, a.choices[i] ?? 0)
          if (!l) return { ok: false, error: `Question ${i + 1}: pick a number from 1 to ${q.options.length}.` }
          answers[q.question] = l
        }
      }
    } else if (a.kind === 'text') {
      if (qs.length !== 1 || !first) return { ok: false, error: `There are ${qs.length} questions; answer them by number.` }
      answers[first.question] = a.text
    } else return { ok: false, error: 'This is a question, not a yes/no approval.' }

    this.settle(r, { behavior: 'allow', updatedInput: { ...(r.pendingInput ?? {}), answers } })
    return { ok: true, said: Object.values(answers).join('; ') }
  }

  /** Saved Claude Code sessions elsewhere on this machine, newest first (not ones already in the list). */
  async external(limit = 80): Promise<CcExternal[]> {
    if (!this.d.history) return []
    const mine = new Set([...this.rts.values()].map((r) => r.s.sdkSessionId).filter(Boolean))
    const root = path.resolve(this.cfg.workspaceRoot).toLowerCase()
    return (await this.d.history.list(limit)).filter((x) => !mine.has(x.sessionId) && !(x.cwd && path.resolve(x.cwd).toLowerCase().startsWith(root)))
  }

  /** A saved session's transcript as events (read-only preview). */
  async externalEvents(sessionId: string, cwd?: string): Promise<CcEvent[]> {
    if (!this.d.history) return []
    return historyEvents(await this.d.history.messages(sessionId, cwd))
  }

  /**
   * Bring a saved session into the list so it can be continued by voice. It works in its own project
   * folder (fenced to it; shell commands always ask) and its first run forks the conversation, so the
   * original transcript is left as it was.
   */
  async attach(x: { sessionId: string; title: string; cwd: string }): Promise<CcResult<{ session: CcSession }>> {
    const max = this.cfg.maxSessions ?? 4
    if (this.rts.size >= max) return { ok: false, error: `Already at the limit of ${max} sessions.` }
    if (!x.cwd || !fs.existsSync(x.cwd)) return { ok: false, error: 'Its project folder no longer exists.' }
    const dup = [...this.rts.values()].find((r) => r.s.sdkSessionId === x.sessionId)
    if (dup) return { ok: true, session: this.snap(dup) }
    const t = this.now()
    const s: CcSession = {
      id: `cc${++this.seq}-${t.toString(36)}`, name: x.title.trim().slice(0, 60) || path.basename(x.cwd), workspace: path.resolve(x.cwd), status: 'idle',
      sdkSessionId: x.sessionId, forkOnResume: true, external: true, queued: [], lastSummary: '', costUsd: 0, turns: 0, createdAt: t, updatedAt: t,
    }
    const r: Rt = { s, events: [], lastText: '' }
    try {
      r.events = (await this.externalEvents(x.sessionId, x.cwd)).slice(-(this.d.eventBuffer ?? 200)).map((e) => ({ ...e, t }))
    } catch { /* the transcript is only context; attaching still works */ }
    this.rts.set(s.id, r)
    this.log(r, 'status', `Continued here from ${path.basename(x.cwd)} (a copy: the original session is untouched)`)
    this.changed(r)
    return { ok: true, session: this.snap(r) }
  }

  rename(id: string, name: string): CcResult {
    const r = this.rts.get(id)
    if (!r) return { ok: false, error: 'No such session.' }
    if (!name.trim()) return { ok: false, error: 'Empty name.' }
    r.s.name = name.trim()
    this.changed(r)
    return { ok: true }
  }

  /** Fresh start: stop it and forget the conversation, so the next prompt begins a new one. Files stay. */
  async reset(id: string): Promise<CcResult> {
    const r = this.rts.get(id)
    if (!r) return { ok: false, error: 'No such session.' }
    await this.stop(id)
    r.s.sdkSessionId = undefined
    r.s.status = 'idle'
    r.s.lastSummary = ''
    this.log(r, 'status', 'Fresh start: new conversation, same folder.')
    this.changed(r)
    return { ok: true }
  }

  /** Stop it and drop it from the list. Its workspace folder is left on disk. */
  async remove(id: string): Promise<CcResult> {
    if (!this.rts.has(id)) return { ok: false, error: 'No such session.' }
    await this.stop(id)
    this.rts.delete(id)
    this.d.persist?.(this.list())
    this.emit({ type: 'removed', id })
    return { ok: true }
  }

  /** Remove a queued prompt (index 0-based). */
  dequeue(id: string, index: number): CcResult {
    const r = this.rts.get(id)
    if (!r || index < 0 || index >= r.s.queued.length) return { ok: false, error: 'No such queued prompt.' }
    r.s.queued.splice(index, 1)
    this.changed(r)
    return { ok: true }
  }

  // ---- internals ----
  private now(): number { return (this.d.now ?? Date.now)() }

  private snap(r: Rt): CcSession { return { ...r.s, queued: [...r.s.queued], pending: r.s.pending && { ...r.s.pending } as CcPending } }

  private emit(e: CcManagerEvent): void { for (const fn of this.listeners) fn(e) }

  private changed(r: Rt): void {
    r.s.updatedAt = this.now()
    this.emit({ type: 'session', session: this.snap(r) })
    this.d.persist?.(this.list())
  }

  private log(r: Rt, kind: CcEvent['kind'], text: string, extra: Partial<CcEvent> = {}): void {
    this.push(r, { t: this.now(), kind, text, ...extra })
  }

  private push(r: Rt, e: CcEvent): void {
    r.events.push(e)
    const cap = this.d.eventBuffer ?? 200
    if (r.events.length > cap) r.events.splice(0, r.events.length - cap)
    this.emit({ type: 'event', id: r.s.id, event: e })
  }

  /** Resolve the blocked canUseTool promise (if any) and clear the pending prompt. */
  private settle(r: Rt, result: CcPermissionResult): void {
    const resolve = r.resolve
    r.resolve = undefined
    r.pendingInput = undefined
    if (r.s.pending) {
      r.s.pending = undefined
      if (r.s.status === 'needs_input' || r.s.status === 'needs_permission') r.s.status = 'running'
      this.changed(r)
    }
    resolve?.(result)
  }

  private ensureRun(r: Rt): void {
    if (r.run) return
    const input = new Pushable<unknown>()
    r.input = input
    const run = this.d.sdk({
      cwd: r.s.workspace,
      model: this.cfg.model || undefined,
      resume: r.s.sdkSessionId,
      fork: r.s.forkOnResume && !!r.s.sdkSessionId,
      input,
      canUseTool: (name, inp) => this.canUseTool(r, name, inp),
      gate: (name, inp) => {
        const v = checkToolUse(name, inp, { root: r.s.workspace })
        if (!v.allow) this.log(r, 'denied', v.reason)
        return v
      },
    })
    r.run = run
    void this.pump(r, run)
  }

  private dispatch(r: Rt, text: string): void {
    this.ensureRun(r)
    this.log(r, 'user', text)
    r.lastText = ''
    r.s.status = 'running'
    this.changed(r)
    r.input?.push(userMsg(text, r.s.sdkSessionId))
  }

  private async pump(r: Rt, run: CcRun): Promise<void> {
    try {
      for await (const m of run.messages) this.handle(r, m)
    } catch (e) {
      if (r.run === run) {
        this.log(r, 'error', (e as Error).message)
        r.s.status = 'error'
        r.s.lastSummary = `Connection problem: ${(e as Error).message}`
        this.changed(r)
      }
    } finally {
      if (r.run === run) {
        // Stream ended: the process is gone. Keep the SDK session id so the next send resumes.
        r.run = undefined
        r.input = undefined
        this.settle(r, { behavior: 'deny', message: 'Session ended.', interrupt: true })
        if (r.s.status === 'running') { r.s.status = 'stopped'; this.changed(r) }
      }
    }
  }

  private handle(r: Rt, m: any): void {
    if (m.type === 'system' && m.subtype === 'init' && m.session_id) {
      if (r.s.sdkSessionId !== m.session_id || r.s.forkOnResume) { r.s.sdkSessionId = m.session_id; r.s.forkOnResume = undefined; this.changed(r) }
    } else if (m.type === 'system' && m.subtype === 'permission_denied') {
      this.log(r, 'denied', String(m.message ?? m.tool_name ?? 'Permission denied'))
    } else if (m.type === 'assistant' || m.type === 'user') {
      for (const e of messageEvents(m, this.now())) {
        if (e.kind === 'text') r.lastText = e.text
        this.push(r, e)
      }
    } else if (m.type === 'result') this.onResult(r, m)
  }

  private onResult(r: Rt, m: any): void {
    r.s.costUsd += Number(m.total_cost_usd) || 0
    r.s.turns += Number(m.num_turns) || 0
    const aborted = String(m.terminal_reason ?? '').startsWith('aborted')
    if (aborted) {
      r.s.status = 'idle'
      r.s.lastSummary = 'Interrupted.'
    } else if (m.is_error) {
      this.log(r, 'error', String(m.result ?? m.subtype))
      r.s.status = 'error'
      r.s.lastSummary = String(m.result ?? 'The run failed.')
    } else {
      r.s.status = 'idle'
      r.s.lastSummary = String(m.result ?? r.lastText ?? '')
      this.log(r, 'result', r.s.lastSummary, { durationMs: Number(m.duration_ms) || undefined, costUsd: Number(m.total_cost_usd) || undefined, turns: Number(m.num_turns) || undefined })
    }
    this.changed(r)
    if (!aborted && !m.is_error) this.emit({ type: 'finished', id: r.s.id, name: r.s.name, summary: r.s.lastSummary })

    // Next: a redirect beats the queue; an interrupt otherwise leaves the queue alone for the user to decide.
    const next = r.redirect ?? (aborted || m.is_error ? undefined : r.s.queued.shift())
    r.redirect = undefined
    if (next) this.dispatch(r, next)
  }

  private canUseTool(r: Rt, toolName: string, input: Record<string, unknown>): Promise<CcPermissionResult> {
    if (toolName === 'AskUserQuestion') {
      const questions = parseQuestions(input)
      if (!questions.length) return Promise.resolve({ behavior: 'allow', updatedInput: input })
      return this.block(r, input, {
        id: `${r.s.id}-q${++this.seq}`, kind: 'question', toolName: 'AskUserQuestion', questions,
        summary: questions.map((q) => q.question).join(' '),
      }, 'needs_input')
    }
    // a session attached to a real project folder always asks before running commands
    if (SHELL.has(toolName) && (r.s.external || (this.cfg.approveShell ?? true))) {
      const cmd = String(input.command ?? '')
      return this.block(r, input, { id: `${r.s.id}-p${++this.seq}`, kind: 'permission', toolName, summary: `Run: ${cmd}` }, 'needs_permission')
    }
    return Promise.resolve({ behavior: 'allow', updatedInput: input })
  }

  private block(r: Rt, input: Record<string, unknown>, pending: CcPending, status: 'needs_input' | 'needs_permission'): Promise<CcPermissionResult> {
    return new Promise((resolve) => {
      r.resolve = resolve
      r.pendingInput = input
      r.s.pending = pending
      r.s.status = status
      this.changed(r)
      this.emit({ type: 'needs-input', id: r.s.id, name: r.s.name, pending })
    })
  }
}

function parseQuestions(input: Record<string, unknown>): CcQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : []
  return raw.map((q: any) => ({
    question: String(q.question ?? ''),
    header: String(q.header ?? ''),
    options: (Array.isArray(q.options) ? q.options : []).map((o: any) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined })),
    multiSelect: !!q.multiSelect,
  })).filter((q) => q.question && q.options.length)
}
