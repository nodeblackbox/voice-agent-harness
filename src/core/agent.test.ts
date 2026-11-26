import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { DEFAULT_SETTINGS } from '../main/services/settings'
import { Agent, FINAL_OVERDUE_MS } from './agent'
import type { AgentEvent } from '@shared/types'
import { MemoryStore } from './memory/store'

let dir: string
let store: MemoryStore

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'va-agent-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const make = () => {
  const events: AgentEvent[] = []
  const traces: Array<Record<string, unknown>> = []
  const restartStuck = vi.fn()
  const agent = new Agent({
    store,
    settings: () => DEFAULT_SETTINGS,
    keys: { keysFor: () => [] },
    customStyles: () => [],
    skills: () => [],
    mcp: { enabled: () => false, tools: () => ({}) } as never,
    search: { configured: () => false } as never,
    ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck },
    emit: (e) => events.push(e),
    emitAudio: () => undefined,
    cancelAudio: () => undefined,
    log: () => undefined,
    trace: (e) => traces.push(e)
  })
  agent.setMic(true)
  const speak = (): void => {
    agent.onSpeechStart()
    agent.onSpeechEnd({ reason: 'done', silenceMs: 300, turnP: 0.9 })
  }
  return { agent, events, traces, restartStuck, speak }
}

describe('Agent: waiting for a transcript', () => {
  it('gives up on a transcript that never arrives: back to listening, ears restarted, user told', () => {
    const { agent, events, traces, restartStuck, speak } = make()
    speak()
    expect(agent.sm.state).toBe('thinking')
    vi.advanceTimersByTime(FINAL_OVERDUE_MS - 1)
    expect(restartStuck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(agent.sm.state).toBe('listening')
    expect(restartStuck).toHaveBeenCalledTimes(1)
    expect(traces.some((t) => t.ev === 'turn.final_overdue')).toBe(true)
    expect(events.some((e) => e.type === 'toast' && e.toast.kind === 'warn')).toBe(true)
  })

  it('does not fire when the transcript arrives, even for several queued utterances', () => {
    const { agent, restartStuck, speak } = make()
    speak()
    speak()
    vi.advanceTimersByTime(FINAL_OVERDUE_MS / 2)
    agent.onFinal('', 120)
    vi.advanceTimersByTime(FINAL_OVERDUE_MS / 2)
    agent.onFinal('', 130)
    vi.advanceTimersByTime(FINAL_OVERDUE_MS * 2)
    expect(restartStuck).not.toHaveBeenCalled()
  })

  it('still fires when only the first of two utterances got its transcript', () => {
    const { agent, restartStuck, speak } = make()
    speak()
    speak()
    agent.onFinal('', 120)
    vi.advanceTimersByTime(FINAL_OVERDUE_MS)
    expect(restartStuck).toHaveBeenCalledTimes(1)
  })
})

describe('Agent: picking Kokoro', () => {
  const withKokoro = (ready: boolean) => {
    const start = vi.fn(async () => true)
    const agent = new Agent({
      store,
      settings: () => DEFAULT_SETTINGS,
      keys: { keysFor: () => [] },
      customStyles: () => [],
      skills: () => [],
      mcp: { enabled: () => false, tools: () => ({}) } as never,
      search: { configured: () => false } as never,
      ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck: () => undefined },
      kokoro: { ready: () => ready, start, synth: async () => Buffer.from('x') },
      emit: () => undefined,
      emitAudio: () => undefined,
      cancelAudio: () => undefined,
      log: () => undefined,
      trace: () => undefined
    })
    const s = { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, engine: 'kokoro' as const } }
    const engineFor = (agent as unknown as { engineFor: (s: unknown) => { name: string } }).engineFor.bind(agent)
    return { engineFor, s, start }
  }

  it('Edge speaks while Kokoro is still loading, and the load is kicked off', () => {
    const { engineFor, s, start } = withKokoro(false)
    expect(engineFor(s).name).toBe('edge')
    expect(start).toHaveBeenCalled()
  })

  it('Kokoro speaks once it is loaded', () => {
    const { engineFor, s } = withKokoro(true)
    expect(engineFor(s).name).toBe('kokoro')
  })
})
