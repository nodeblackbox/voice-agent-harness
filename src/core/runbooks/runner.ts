// Runs runbooks in the background: one step at a time, sharing a scratchpad, saving the run after every step
// so a run that is waiting for the user survives a restart. The voice lane never waits for any of this: what a
// run has to say goes through the announcement queue, and the user's reply reaches a waiting run as an event.
// Caps (steps, working time) stop runaway loops; a claude step only runs after the user replied to the run.

import type { RunbookRun, RunbookRunStatus } from '@shared/types'
import type { Playbook } from '../playbooks/schema'
import type { JevClient } from '../jev/client'
import { safeText } from '../jev/client'
import type { Step } from './steps'

export interface RunnerDeps {
  /** The background model: a prompt in, its text out. */
  generate(prompt: string, signal: AbortSignal): Promise<{ text: string; inputTokens?: number; outputTokens?: number }>
  /** Jev for `ask` steps, when it is available; otherwise the model answers them. */
  jev?(): { client: JevClient; timeoutMs: number } | null
  /** Speak at the next pause (the agent's announcement queue). */
  say(text: string): void
  /** Run one of the allowed tools (steps.ts RUNBOOK_TOOLS). */
  tool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** Start a Claude Code session (in plan mode) with a first task, or message one that exists (`session`). */
  claude?(target: { name?: string; session?: string }, prompt: string, folder: 'app' | 'sandbox'): { ok: boolean; note: string }
  /** Persist the run (main writes it to disk). */
  save(run: RunbookRun): void
  trace(ev: string, data: Record<string, unknown>): void
  /** Something about the runs changed (the view refreshes). */
  changed?(): void
  now?(): number
}

/** At most this many runs working or waiting at once; another trigger is held back. */
export const MAX_ACTIVE_RUNS = 3
const KEEP_FINISHED = 30

const ACTIVE: RunbookRunStatus[] = ['running', 'waiting']

/** {{name}} -> the saved value: lists joined with "; ", objects as JSON, missing as empty. */
export function fill(template: string, scratch: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g, (_m, key: string) => {
    const v = scratch[key]
    if (v === undefined || v === null) return ''
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('; ')
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
  })
}

function fillDeep(v: unknown, scratch: Record<string, unknown>): unknown {
  if (typeof v === 'string') return fill(v, scratch)
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, scratch))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, scratch)]))
  return v
}

/** A model's list answer as items: one per line, bullets and numbering removed, "NONE" and blanks dropped. */
export function toList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((l) => l && !/^none\.?$/i.test(l))
}

export class RunbookRunner {
  private runs = new Map<string, RunbookRun>()
  private books = new Map<string, Playbook>()
  private aborts = new Map<string, AbortController>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: RunnerDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)()
  }

  list(): RunbookRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  active(): RunbookRun[] {
    return this.list().filter((r) => ACTIVE.includes(r.status))
  }

  /** Start a run for a fired runbook; null when it is already running or too many are. */
  start(rb: Playbook, trigger: { text: string; recent: string; fields?: Record<string, unknown> }): RunbookRun | null {
    if (!rb.runbook) return null
    const active = this.active()
    if (active.some((r) => r.runbookId === rb.id)) {
      this.deps.trace('runbook.skipped', { id: rb.id, reason: 'already_running' })
      return null
    }
    // a run waiting for an answer owns the next message; a second question now would muddle which reply is whose
    if (active.some((r) => r.status === 'waiting')) {
      this.deps.trace('runbook.skipped', { id: rb.id, reason: 'waiting_for_reply' })
      return null
    }
    if (active.length >= MAX_ACTIVE_RUNS) {
      this.deps.trace('runbook.skipped', { id: rb.id, reason: 'too_many' })
      return null
    }
    const run: RunbookRun = {
      runId: crypto.randomUUID(),
      runbookId: rb.id,
      title: rb.title,
      status: 'running',
      step: rb.runbook.steps[0]!.id,
      // an event's fields ({{session}}, {{changedFiles}}...) are there for the steps too
      scratch: { ...(trigger.fields ?? {}), text: safeText(trigger.text), recent: trigger.recent },
      log: [],
      startedAt: this.now,
      updatedAt: this.now,
      activeMs: 0,
      steps: 0,
      consented: false
    }
    this.runs.set(run.runId, run)
    this.books.set(run.runId, rb)
    this.deps.trace('runbook.start', { runId: run.runId, id: rb.id, title: rb.title })
    this.persist(run)
    void this.drive(run.runId)
    return run
  }

  /**
   * The user's message reaches the run that has waited longest for a reply, which continues with it. Returns what
   * it had asked, so the reply can acknowledge it, or null when no run is waiting.
   */
  deliverReply(text: string): { runId: string; title: string; question?: string; runbookId: string } | null {
    const run = this.list()
      .filter((r) => r.status === 'waiting' && r.waiting)
      .sort((a, b) => a.waiting!.since - b.waiting!.since)[0]
    if (!run || !run.waiting) return null
    const { save, question } = run.waiting
    run.scratch[save] = safeText(text)
    run.consented = true
    this.clearTimer(run.runId)
    const waited = this.now - run.waiting.since
    run.waiting = undefined
    run.status = 'running'
    this.log(run, run.step!, 'wait', 'ok', waited, 'got the reply')
    this.deps.trace('runbook.reply', { runId: run.runId, id: run.runbookId, waitedMs: waited })
    run.step = this.after(run, run.step!)
    this.persist(run)
    void this.drive(run.runId)
    return { runId: run.runId, title: run.title, question, runbookId: run.runbookId }
  }

  cancel(runId: string, reason = 'cancelled by the user'): boolean {
    const run = this.runs.get(runId)
    if (!run || !ACTIVE.includes(run.status)) return false
    this.aborts.get(runId)?.abort()
    this.finish(run, 'cancelled', reason)
    return true
  }

  /** After a restart: waiting runs pick up where they were (or expire); runs cut off mid-step are marked interrupted. */
  resume(saved: RunbookRun[], lookup: (id: string) => Playbook | undefined): void {
    for (const run of saved) {
      if (this.runs.has(run.runId)) continue
      this.runs.set(run.runId, run)
      const rb = lookup(run.runbookId)
      if (run.status === 'running') this.finish(run, 'interrupted', 'the app closed while it was working')
      else if (run.status === 'waiting') {
        if (!rb?.runbook || !run.waiting) this.finish(run, 'cancelled', 'its runbook is gone or was changed')
        else {
          this.books.set(run.runId, rb)
          const left = run.waiting.expiresAt - this.now
          if (left <= 0) this.finish(run, 'expired', 'no reply in time')
          else this.armTimer(run, left)
        }
      }
    }
    this.prune()
    this.deps.changed?.()
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    for (const a of this.aborts.values()) a.abort()
  }

  // ---- the loop ----------------------------------------------------------------------------

  private async drive(runId: string): Promise<void> {
    const run = this.runs.get(runId)
    const rb = this.books.get(runId)
    if (!run || !rb?.runbook) return
    const abort = new AbortController()
    this.aborts.set(runId, abort)
    try {
      while (run.status === 'running') {
        if (!run.step || run.step === 'end') return this.finish(run, 'done')
        const step = rb.runbook.steps.find((s) => s.id === run.step)
        if (!step) return this.finish(run, 'blocked', `there is no step "${run.step}"`)
        if (run.steps >= rb.budget.maxSteps) return this.finish(run, 'out_of_budget', `reached ${rb.budget.maxSteps} steps`)
        if (run.activeMs >= rb.budget.maxSeconds * 1000) return this.finish(run, 'out_of_budget', `worked for ${rb.budget.maxSeconds} s`)
        const t0 = this.now
        let next: string
        try {
          next = await this.exec(run, rb, step, abort.signal)
        } catch (e) {
          if (abort.signal.aborted) return
          run.activeMs += this.now - t0
          this.log(run, step.id, step.do, 'error', this.now - t0, (e as Error).message)
          return this.finish(run, 'blocked', `step "${step.id}" failed: ${(e as Error).message}`)
        }
        // the step may have parked the run (wait) or something may have stopped it meanwhile (cancel)
        const status = run.status as RunbookRunStatus
        if (abort.signal.aborted || (status !== 'running' && status !== 'waiting')) return
        run.activeMs += this.now - t0
        run.steps++
        if (status === 'waiting') {
          this.persist(run)
          return
        }
        run.step = next
        this.persist(run)
      }
    } finally {
      this.aborts.delete(runId)
    }
  }

  /** The step after `id` in the list, or "end". */
  private after(run: RunbookRun, id: string): string {
    const steps = this.books.get(run.runId)?.runbook?.steps ?? []
    const i = steps.findIndex((s) => s.id === id)
    return steps[i + 1]?.id ?? 'end'
  }

  private async exec(run: RunbookRun, rb: Playbook, step: Step, signal: AbortSignal): Promise<string> {
    const t0 = this.now
    const sequential = (): string => (typeof step.next === 'string' ? step.next : this.after(run, step.id))
    const done = (note?: string): void => this.log(run, step.id, step.do, 'ok', this.now - t0, note)

    switch (step.do) {
      case 'model': {
        const r = await this.deps.generate(fill(step.prompt, run.scratch), signal)
        if (step.list) {
          const items = toList(r.text)
          run.scratch[step.save] = items
          run.scratch[`${step.save}_count`] = items.length
          done(`${items.length} item${items.length === 1 ? '' : 's'}`)
        } else {
          run.scratch[step.save] = r.text.trim()
          done(`${r.text.trim().length} characters`)
        }
        if (r.inputTokens || r.outputTokens) this.deps.trace('runbook.usage', { runId: run.runId, step: step.id, inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0 })
        return sequential()
      }
      case 'check': {
        const yes = rb.runbook!.conditions[step.id]!.test(run.scratch)
        done(yes ? 'yes' : 'no')
        return yes ? step.next.yes : step.next.no
      }
      case 'ask': {
        const about = step.about ? run.scratch[step.about] : (run.scratch.reply ?? run.scratch.text)
        const latest = typeof about === 'string' ? about : fill(`{{x}}`, { x: about })
        const answer = await this.answer(step, latest, signal)
        if (step.save) run.scratch[step.save] = answer.key
        done(`${answer.key}${answer.p !== null ? ` (${answer.p.toFixed(2)})` : ''} by ${answer.by}`)
        if (answer.key in step.next) return step.next[answer.key]!
        return answer.key === 'unsure' ? 'end' : this.after(run, step.id)
      }
      case 'say': {
        const text = fill(step.text, run.scratch).trim()
        if (text) this.deps.say(text)
        run.scratch.__said = text
        done()
        return sequential()
      }
      case 'wait': {
        run.status = 'waiting'
        run.waiting = { since: this.now, expiresAt: this.now + step.expireS * 1000, save: step.save, question: typeof run.scratch.__said === 'string' ? run.scratch.__said : undefined }
        this.deps.trace('runbook.wait', { runId: run.runId, id: run.runbookId, step: step.id, expireS: step.expireS })
        this.armTimer(run, step.expireS * 1000)
        this.deps.changed?.()
        return step.id
      }
      case 'tool': {
        const items = step.each ? run.scratch[step.each] : [undefined]
        const list = Array.isArray(items) ? items : []
        const results: unknown[] = []
        for (const item of list) {
          const args = fillDeep(step.args, item === undefined ? run.scratch : { ...run.scratch, item }) as Record<string, unknown>
          results.push(await this.deps.tool(step.tool, args, signal))
        }
        if (step.save) run.scratch[step.save] = step.each ? results : results[0]
        done(step.each ? `${list.length} call${list.length === 1 ? '' : 's'}` : undefined)
        return sequential()
      }
      case 'claude': {
        if (!run.consented) {
          this.log(run, step.id, step.do, 'refused', 0, 'the user has not answered this run yet')
          throw new Error('refused: a Claude Code session starts only after the user replied')
        }
        if (!this.deps.claude) throw new Error('Claude Code sessions are switched off')
        const target = step.session ? { session: fill(step.session, run.scratch) } : { name: fill(step.name ?? 'job', run.scratch) }
        const r = this.deps.claude(target, fill(step.prompt, run.scratch), step.folder)
        if (!r.ok) throw new Error(r.note)
        done(r.note)
        return sequential()
      }
    }
  }

  /** Jev answers when it can; otherwise the model, told to answer with one word. */
  private async answer(step: Extract<Step, { do: 'ask' }>, latest: string, signal: AbortSignal): Promise<{ key: string; p: number | null; by: 'jev' | 'model' }> {
    const jev = this.deps.jev?.()
    if (jev?.client.configured()) {
      const q = step.options ? { type: 'choice' as const, instructions: step.question, criteria: step.options } : { type: 'noul' as const, instructions: step.question }
      try {
        const r = await jev.client.ask({ latest }, { q }, { timeoutMs: Math.max(jev.timeoutMs, 2000), signal })
        const a = r.answers.q!
        if (a.type === 'choice') return { key: a.confidence >= step.min ? a.choice : 'unsure', p: a.confidence, by: 'jev' }
        return { key: a.noul >= step.min ? 'yes' : a.noul <= 1 - step.min ? 'no' : 'unsure', p: a.noul, by: 'jev' }
      } catch {
        // fall through to the model
      }
    }
    const keys = step.options ? Object.keys(step.options) : ['yes', 'no']
    const meanings = step.options ? `\n${Object.entries(step.options).map(([k, v]) => `${k}: ${v}`).join('\n')}` : ''
    const r = await this.deps.generate(`${step.question}${meanings}\n\n\`latest\`: ${latest}\n\nAnswer with exactly one word from: ${keys.join(', ')}. If it is impossible to tell, answer unsure.`, signal)
    const word = r.text.trim().toLowerCase().replace(/[^a-z_]/g, ' ').split(/\s+/).find((w) => keys.includes(w) || w === 'unsure') ?? 'unsure'
    return { key: word, p: null, by: 'model' }
  }

  // ---- bookkeeping -------------------------------------------------------------------------

  private log(run: RunbookRun, step: string, kind: string, outcome: RunbookRun['log'][number]['outcome'], ms: number, note?: string): void {
    run.log.push({ step, kind, outcome, ms, note, at: this.now })
    if (run.log.length > 60) run.log.splice(0, run.log.length - 60)
    this.deps.trace('runbook.step', { runId: run.runId, id: run.runbookId, step, kind, outcome, ms, note })
  }

  private finish(run: RunbookRun, status: RunbookRunStatus, reason?: string): void {
    this.clearTimer(run.runId)
    run.status = status
    run.reason = reason
    run.waiting = undefined
    this.deps.trace('runbook.done', { runId: run.runId, id: run.runbookId, status, steps: run.steps, ms: this.now - run.startedAt, reason })
    this.persist(run)
    this.prune()
  }

  private persist(run: RunbookRun): void {
    run.updatedAt = this.now
    try {
      this.deps.save(run)
    } catch {
      // a run that cannot be saved still runs; it just will not survive a restart
    }
    this.deps.changed?.()
  }

  private armTimer(run: RunbookRun, ms: number): void {
    this.clearTimer(run.runId)
    const t = setTimeout(() => {
      if (run.status === 'waiting') this.finish(run, 'expired', 'no reply in time')
    }, ms)
    t.unref?.()
    this.timers.set(run.runId, t)
  }

  private clearTimer(runId: string): void {
    const t = this.timers.get(runId)
    if (t) clearTimeout(t)
    this.timers.delete(runId)
  }

  /** Keep every active run and the newest finished ones. */
  private prune(): void {
    const finished = this.list().filter((r) => !ACTIVE.includes(r.status))
    for (const r of finished.slice(KEEP_FINISHED)) {
      this.runs.delete(r.runId)
      this.books.delete(r.runId)
    }
  }
}
