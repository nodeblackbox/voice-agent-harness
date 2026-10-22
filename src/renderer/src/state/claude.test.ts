import { describe, expect, it } from 'vitest'
import type { CcSession } from '@shared/claude'
import { applyClaudeEvent, OUTPUT_CAP, statusLabel, waitingOnUser } from './claude'

const session = (id: string, over: Partial<CcSession> = {}): CcSession => ({
  id, name: id, workspace: `C:\\ws\\${id}`, status: 'idle', queued: [], lastSummary: '', costUsd: 0, turns: 0, createdAt: 1, updatedAt: 1, ...over,
})

describe('applyClaudeEvent', () => {
  it('adds a new session and replaces an existing one in place', () => {
    let s = applyClaudeEvent({ sessions: [], output: {} }, { type: 'session', session: session('a') })
    s = applyClaudeEvent(s, { type: 'session', session: session('b') })
    s = applyClaudeEvent(s, { type: 'session', session: session('a', { status: 'running' }) })
    expect(s.sessions.map((x) => [x.id, x.status])).toEqual([['a', 'running'], ['b', 'idle']])
  })

  it('appends output per session and caps it', () => {
    let s = { sessions: [], output: {} } as ReturnType<typeof applyClaudeEvent>
    for (let i = 0; i < OUTPUT_CAP + 20; i++) s = applyClaudeEvent(s, { type: 'event', id: 'a', event: { t: i, kind: 'text', text: String(i) } })
    expect(s.output.a).toHaveLength(OUTPUT_CAP)
    expect(s.output.a![OUTPUT_CAP - 1]!.text).toBe(String(OUTPUT_CAP + 19))
    expect(s.output.b).toBeUndefined()
  })

  it('ignores announcement-only events', () => {
    const s = { sessions: [session('a')], output: {} }
    expect(applyClaudeEvent(s, { type: 'finished', id: 'a', name: 'a', summary: 'x' })).toBe(s)
  })
})

describe('helpers', () => {
  it('lists sessions waiting on the user, oldest first', () => {
    const p = { id: 'p', kind: 'permission' as const, toolName: 'Bash', summary: 'Run: x' }
    const list = [session('a', { pending: p, updatedAt: 5 }), session('b'), session('c', { pending: p, updatedAt: 2 })]
    expect(waitingOnUser(list).map((x) => x.id)).toEqual(['c', 'a'])
  })
  it('labels statuses for people', () => {
    expect(statusLabel('needs_input')).toBe('needs you')
    expect(statusLabel('running')).toBe('working')
  })
})
