import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('./turn/runner', () => ({
  TurnRunner: class {
    run(): Promise<never> {
      return new Promise(() => undefined)
    }
  }
}))
// the runbooks' background model answers "yes" to any question it is asked
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: vi.fn(async () => ({ text: 'yes', usage: {} })) }))

import { DEFAULT_SETTINGS } from '../main/services/settings'
import { Agent } from './agent'
import { MemoryStore } from './memory/store'
import { parsePlaybook, type Playbook } from './playbooks/schema'
import { TEMPLATES } from './playbooks/templates'
import type { CcSession } from '@shared/claude'
import type { Settings } from '@shared/types'

let dir: string
let store: MemoryStore
const agents: Agent[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'va-events-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})
afterEach(() => {
  vi.useRealTimers()
  for (const a of agents.splice(0)) a.shutdown()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const template = (id: string): Playbook => {
  const r = parsePlaybook(id, TEMPLATES.find((t) => t.id === id)!.text)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.playbook
}

const session = (over: Partial<CcSession>): CcSession => ({ id: 's1', name: 'fix chips', workspace: '/repo', status: 'idle', queued: [], lastSummary: '', costUsd: 0, turns: 1, createdAt: 0, updatedAt: 0, ...over })

function make(playbooks: Playbook[], sessions: CcSession[] = []) {
  const settings: Settings = { ...DEFAULT_SETTINGS, claude: { ...DEFAULT_SETTINGS.claude, enabled: true } }
  const claude = { list: () => sessions, send: vi.fn(() => ({ ok: true, queued: false })), start: vi.fn() }
  const traces: Array<Record<string, unknown>> = []
  const agent = new Agent({
    store,
    settings: () => settings,
    keys: { keysFor: (p: string) => (p === 'anthropic' ? ['test-key'] : []) },
    customStyles: () => [],
    skills: () => [],
    playbooks: () => playbooks,
    claude: claude as never,
    mcp: { enabled: () => false, tools: () => ({}) } as never,
    search: { configured: () => false } as never,
    ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck: () => undefined },
    emit: () => undefined,
    emitAudio: () => undefined,
    cancelAudio: () => undefined,
    log: () => undefined,
    trace: (e) => traces.push(e)
  })
  agents.push(agent)
  const said = vi.spyOn(agent, 'announce').mockImplementation(() => undefined)
  return { agent, claude, said, traces }
}

describe('Agent: runbooks on session and clock events', () => {
  it('offers to push after a session finishes with changes, and on a yes tells that session to', async () => {
    const { agent, claude, said, traces } = make([template('push-after-session')], [session({})])
    agent.onEvent('cc.finished', { session: 'fix chips', sessionId: 's1', summary: 'Made the chips bigger', folder: '/repo', mode: 'auto', changedFiles: 0 }, 'x')
    expect(agent.runbooks.list()).toEqual([])

    agent.onEvent('cc.finished', { session: 'fix chips', sessionId: 's1', summary: 'Made the chips bigger', folder: '/repo', mode: 'auto', changedFiles: 3, changes: '3 changed files' }, 'The session finished')
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).toBe('waiting'))
    expect(said).toHaveBeenCalledWith('fix chips left 3 changed files that are not committed. Want it to commit and push them?')
    expect(traces.find((t) => t.ev === 'trigger.fired')).toMatchObject({ id: 'push-after-session', by: 'cc.finished', why: 'cc.finished and changedFiles > 0 (changedFiles 3)' })

    agent.runbooks.deliverReply('yes push it')
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).not.toBe('running'))
    expect(agent.runbooks.list()[0]?.reason).toBeUndefined()
    expect(agent.runbooks.list()[0]?.status).toBe('done')
    expect(claude.send).toHaveBeenCalledWith('s1', expect.stringContaining('push the current branch'))
    expect(said).toHaveBeenLastCalledWith('Asked fix chips to commit and push.')
  })

  it('reminds about a session waiting a long time, on the ten-minute tick, at most every 25 minutes', async () => {
    const start = new Date(2026, 10, 26, 14, 0, 30).getTime()
    const sessions = [session({ status: 'needs_input', updatedAt: start - 12 * 60_000 }), session({ id: 's2', name: 'spend tab', status: 'running' })]
    const { agent, said } = make([template('waiting-session-reminder')], sessions)
    expect(agent.clockFields(new Date(start))).toMatchObject({ time: '14:00', minute: 0, weekday: 'thursday', sessionsWaiting: 1, waitingNames: 'fix chips', oldestWaitMinutes: 12, sessionsWorking: 1 })

    agent.onEvent('clock.tick', agent.clockFields(new Date(start + 5 * 60_000)), 'x')
    expect(agent.runbooks.list()).toEqual([])
    agent.onEvent('clock.tick', agent.clockFields(new Date(start)), 'x')
    await vi.waitFor(() => expect(said).toHaveBeenCalledWith('Just a reminder, Claude Code is still waiting on you in fix chips, the longest for about 12 minutes.'))
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).toBe('done'))
    agent.onEvent('clock.tick', agent.clockFields(new Date(start + 10 * 60_000)), 'x')
    expect(said).toHaveBeenCalledTimes(1)
  })

  it('ticks the clock on whole minutes, only when a runbook listens to it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 26, 9, 59, 50))
    const { agent } = make([template('waiting-session-reminder')])
    const onEvent = vi.spyOn(agent, 'onEvent')
    agent.startClock()
    vi.advanceTimersByTime(9_000)
    expect(onEvent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(onEvent).toHaveBeenCalledWith('clock.tick', expect.objectContaining({ time: '10:00', minute: 0 }), 'It is 10:00 on thursday.')
    vi.advanceTimersByTime(60_000)
    expect(onEvent).toHaveBeenCalledTimes(2)

    const quiet = make([template('long-message-breakdown')]).agent
    const quietEvent = vi.spyOn(quiet, 'onEvent')
    quiet.startClock()
    vi.advanceTimersByTime(120_000)
    expect(quietEvent).not.toHaveBeenCalled()
  })

  it('the schedule event runs a scheduled runbook at its time, and cc.idle comes at its marks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 26, 17, 29, 50)) // a Thursday
    const on = { ...template('push-reminder'), enabled: true }
    const idle = { ...template('idle-session-nudge'), enabled: true }
    const t0 = new Date(2026, 10, 26, 17, 0, 0).getTime()
    const { agent } = make([on, idle], [session({ sdkSessionId: 'sdk', status: 'idle', updatedAt: t0 }), session({ id: 's2', name: 'busy', sdkSessionId: 'x', status: 'running', updatedAt: t0 })])
    const onEvent = vi.spyOn(agent, 'onEvent')
    agent.startClock()
    vi.advanceTimersByTime(11_000)
    expect(onEvent).toHaveBeenCalledWith('schedule', expect.objectContaining({ time: '17:30' }), 'It is 17:30 on thursday.')
    expect(onEvent).toHaveBeenCalledWith('cc.idle', expect.objectContaining({ session: 'fix chips', idleMinutes: 30 }), expect.any(String))
    expect(onEvent.mock.calls.filter((c) => c[0] === 'cc.idle')).toHaveLength(1)
    vi.advanceTimersByTime(60_000)
    expect(onEvent.mock.calls.filter((c) => c[0] === 'cc.idle')).toHaveLength(1) // 31 minutes is not a mark
  })

  it('app.start carries the time and the sessions', () => {
    const { agent } = make([], [session({}), session({ id: 's2', status: 'needs_input' })])
    const onEvent = vi.spyOn(agent, 'onEvent')
    agent.appStarted(new Date(2026, 10, 26, 8, 15))
    expect(onEvent).toHaveBeenCalledWith('app.start', expect.objectContaining({ time: '08:15', hour: 8, weekday: 'thursday', sessions: 2, sessionsWaiting: 1 }), expect.any(String))
  })

  it('offers to compact a full session and sends /compact with what to keep', async () => {
    const { agent, claude, said } = make([template('compact-when-full')], [session({})])
    agent.onEvent('cc.context', { session: 'fix chips', sessionId: 's1', percent: 83, previous: 74, tokens: 166_000, maxTokens: 200_000 }, 'x')
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).toBe('waiting'))
    expect(said).toHaveBeenCalledWith(expect.stringContaining('fix chips has used 83% of its context'))
    agent.runbooks.deliverReply('yes go ahead')
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).toBe('done'))
    expect(claude.send).toHaveBeenCalledWith('s1', expect.stringMatching(/^\/compact\b/))
  })
})
