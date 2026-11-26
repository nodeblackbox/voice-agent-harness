// Reviews of playbook triggers (core/playbooks/evaluate.ts), wired to this app: the user's recent messages from
// the store, their marks from <userData>/playbook-labels.json, Jev when it can judge and the chat model when not.
// The Playbooks view (over IPC) and the voice tools (playbook_review, playbook_mark) use the same instance.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { generateText } from 'ai'
import type { ChatMessage, PlaybookEvalResult, PlaybookLabel, Settings } from '@shared/types'
import type { MemoryStore } from '@core/memory/store'
import type { JevClient } from '@core/jev/client'
import type { KeySource } from '@core/providers/keys'
import { ModelFactory } from '@core/providers/factory'
import { MODELS, findModel } from '@core/providers/models'
import { resolveModel } from '@core/providers/resolve'
import { evaluatePlaybook, suggestTrigger } from '@core/playbooks/evaluate'
import type { DraftResult } from '@core/playbooks/author'
import type { ParseIssue } from '@core/playbooks/schema'

type Labels = Record<string, Record<string, PlaybookLabel>>

/** The user's marks, by playbook id then message id. Small, so one JSON file. */
export class PlaybookLabels {
  constructor(private readonly path: string) {}

  private read(): Labels {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Labels) : {}
    } catch {
      return {}
    }
  }

  get(id: string): Record<string, PlaybookLabel> {
    return this.read()[id] ?? {}
  }

  set(id: string, messageId: string, label: PlaybookLabel | null): void {
    const all = this.read()
    const mine = { ...(all[id] ?? {}) }
    if (label) mine[messageId] = label
    else delete mine[messageId]
    all[id] = mine
    writeFileSync(this.path, JSON.stringify(all, null, 1))
  }
}

export interface ReviewDeps {
  settings: () => Settings
  keys: KeySource
  store: MemoryStore
  jev: JevClient
  labels: PlaybookLabels
  /** The current file text of a playbook. */
  source: (id: string) => string | undefined
  trace: (ev: string, data: Record<string, unknown>) => void
}

export class PlaybookReview {
  constructor(private readonly d: ReviewDeps) {}

  private generate = async (system: string | undefined, prompt: string): Promise<string> => {
    const s = this.d.settings()
    const model = resolveModel(s.modelId, this.d.keys)?.model ?? findModel(s.modelId) ?? MODELS[0]!
    const r = await generateText({ model: new ModelFactory(this.d.keys).create(model).model, system, prompt, maxOutputTokens: 1200, temperature: 0, abortSignal: AbortSignal.timeout(45_000) })
    return r.text
  }

  private jev() {
    const t = this.d.settings().playbooks
    return t.useJev ? { client: this.d.jev, timeoutMs: t.jevTimeoutMs, intentMin: t.intentMin } : undefined
  }

  /** Review a playbook: the file as it is on disk, or a draft from the editor. */
  async evaluate(id: string, text?: string): Promise<PlaybookEvalResult & { errors: ParseIssue[] }> {
    const source = text ?? this.d.source(id)
    if (!source) return { errors: [{ line: 0, message: `no playbook called "${id}"` }], rows: [], summary: { checked: 0, fires: 0, agree: 0, misses: 0, falseFires: 0, unsure: 0 } }
    const t0 = Date.now()
    const r = await evaluatePlaybook({
      id,
      text: source,
      messages: this.d.store.recentUserMessages(40),
      labels: this.d.labels.get(id),
      tuning: { ...this.d.settings().playbooks },
      jev: this.jev(),
      generate: (prompt) => this.generate(undefined, prompt)
    })
    if (!r.errors.length) this.d.trace('playbook.review', { id, ms: Date.now() - t0, ...r.summary })
    return r
  }

  label(id: string, messageId: string, label: PlaybookLabel | null): void {
    this.d.labels.set(id, messageId, label)
    this.d.trace('playbook.label', { id, messageId, label })
  }

  /** A draft with a tighter trigger, from a fresh review (or the rows given). Nothing is saved. */
  async suggest(id: string, text?: string): Promise<DraftResult> {
    const source = text ?? this.d.source(id)
    if (!source) return { ok: false, errors: [{ line: 0, message: `no playbook called "${id}"` }], text: '' }
    const review = await this.evaluate(id, source)
    if (review.errors.length) return { ok: false, errors: review.errors, text: source }
    if (!review.summary.misses && !review.summary.falseFires) return { ok: false, errors: [{ line: 0, message: 'the review found nothing to fix: every judged message agrees with the trigger' }], text: source }
    const r = await suggestTrigger({ id, text: source, rows: review.rows, jev: this.jev()?.client.configured() ?? false }, (system, prompt) => this.generate(system, prompt))
    this.d.trace('playbook.suggest', { id, ok: r.ok, misses: review.summary.misses, falseFires: review.summary.falseFires })
    return r
  }

  /** The user's message before the current one (for "that one shouldn't have fired"). */
  previousUserMessage(): ChatMessage | undefined {
    return this.d.store.recentUserMessages(2)[1]
  }
}
