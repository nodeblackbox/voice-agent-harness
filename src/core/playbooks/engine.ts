// Decides which playbooks fire on a user turn, and builds the block of instructions that goes into that
// reply's prompt. Cheapest checks first (enabled, event, `when`, phrases), then the gates (cooldown,
// per-conversation cap), then priority and the cap on how many can shape one reply. Every playbook that
// matched is traced, fired or not, with the reason, so the Console can answer "why did it do that?".
// No randomness: a playbook either fires or it does not.

import { PRIORITIES, contentWords, type Playbook } from './schema'

export interface TurnFacts {
  text: string
  via: 'voice' | 'typed'
  project: string
  projectId: string
  turnIndex: number
  fromSplit: boolean
}

export interface EngineLimits {
  /** Most playbooks that may shape one reply; the rest are dropped with reason "cap". */
  maxInjected: number
  /** Each playbook's instruction is cut to this many characters in the prompt. */
  injectMaxChars: number
  /** Exposed to `when:` as `tuning.*`. */
  tuning: Record<string, number | string | boolean>
}

export interface Firing {
  id: string
  title: string
  why: string
}

export type DropReason = 'disabled' | 'cooldown' | 'session_cap' | 'cap'

export type EngineTrace = (ev: string, data: Record<string, unknown>) => void

const EVENT = 'turn.user'

function listensTo(p: Playbook, ev: string): boolean {
  return p.triggers.events.some((e) => e === ev || (e.endsWith('.') && ev.startsWith(e)))
}

const rank = (p: Playbook): number => PRIORITIES.indexOf(p.priority)

export class PlaybookEngine {
  private lastFired = new Map<string, number>()
  private firedCount = new Map<string, number>()

  constructor(
    private trace: EngineTrace,
    private now: () => number = Date.now
  ) {}

  /** A new conversation: cooldowns and per-conversation caps start over. */
  resetSession(): void {
    this.lastFired.clear()
    this.firedCount.clear()
  }

  /** The playbooks that fire on this user message, and the prompt block they add (empty when none). */
  onUserTurn(playbooks: Playbook[], facts: TurnFacts, limits: EngineLimits): { block: string; fired: Firing[] } {
    const words = contentWords(facts.text)
    const ctx = {
      ...facts,
      chars: facts.text.length,
      words: facts.text.trim() ? facts.text.trim().split(/\s+/).length : 0,
      tuning: limits.tuning
    }
    const said = new Set(words)

    const matched: Array<{ p: Playbook; why: string }> = []
    for (const p of playbooks) {
      if (!listensTo(p, EVENT)) continue
      const reasons: string[] = []
      if (p.condition) {
        if (!p.condition.test(ctx)) continue
        reasons.push(`when ${p.condition.source}${describeNumbers(p.condition.names, ctx)}`)
      }
      if (p.phrases.length) {
        const hit = p.phrases.find((ph) => ph.words.every((w) => said.has(w)))
        if (!hit) continue
        reasons.push(`said "${hit.text}"`)
      }
      matched.push({ p, why: reasons.join(' and ') || `every ${EVENT}` })
    }

    const now = this.now()
    const passed: typeof matched = []
    for (const m of matched) {
      const reason = this.gate(m.p, now)
      if (reason) this.trace('trigger.dropped', { id: m.p.id, reason, title: m.p.title })
      else passed.push(m)
    }

    passed.sort((a, b) => rank(b.p) - rank(a.p) || a.p.id.localeCompare(b.p.id))
    const chosen = passed.slice(0, Math.max(0, limits.maxInjected))
    for (const m of passed.slice(chosen.length)) this.trace('trigger.dropped', { id: m.p.id, reason: 'cap' satisfies DropReason, title: m.p.title })

    const fired: Firing[] = []
    const lines: string[] = []
    for (const { p, why } of chosen) {
      this.lastFired.set(p.id, now)
      this.firedCount.set(p.id, (this.firedCount.get(p.id) ?? 0) + 1)
      this.trace('trigger.fired', { id: p.id, title: p.title, by: EVENT, why, priority: p.priority })
      const body = p.body.length > limits.injectMaxChars ? `${p.body.slice(0, limits.injectMaxChars - 1)}…` : p.body
      lines.push(`- ${p.title} (goal: ${p.goal})\n${body}`)
      this.trace('playbook.applied', { id: p.id, mode: p.mode, chars: body.length })
      fired.push({ id: p.id, title: p.title, why })
    }
    return { block: lines.join('\n\n'), fired }
  }

  private gate(p: Playbook, now: number): DropReason | null {
    if (!p.enabled) return 'disabled'
    const last = this.lastFired.get(p.id)
    if (p.gates.cooldownS > 0 && last !== undefined && now - last < p.gates.cooldownS * 1000) return 'cooldown'
    if (p.gates.maxPerSession !== null && (this.firedCount.get(p.id) ?? 0) >= p.gates.maxPerSession) return 'session_cap'
    return null
  }
}

/** " (chars 1834, tuning.longMessageChars 1200)": the numbers the condition read, so the log shows why it was true. */
function describeNumbers(names: string[], ctx: Record<string, unknown>): string {
  const parts: string[] = []
  for (const name of names) {
    let v: unknown = ctx
    for (const k of name.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined
    if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${name} ${String(v)}`)
    else if (typeof v === 'string' && name !== 'text') parts.push(`${name} "${v.length > 30 ? `${v.slice(0, 29)}…` : v}"`)
  }
  return parts.length ? ` (${parts.join(', ')})` : ''
}
