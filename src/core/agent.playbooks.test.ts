import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

// capture the system prompt each turn hands to the model, without calling a model
const prompts: Array<{ stable: string; live: string }> = []
vi.mock('./turn/runner', () => ({
  TurnRunner: class {
    constructor(deps: { system: { stable: string; live: string } }) {
      prompts.push(deps.system)
    }
    run(): Promise<never> {
      return new Promise(() => undefined)
    }
  }
}))

import { DEFAULT_SETTINGS } from '../main/services/settings'
import { Agent } from './agent'
import { MemoryStore } from './memory/store'
import { parsePlaybook, type Playbook } from './playbooks/schema'
import { TEMPLATES } from './playbooks/templates'
import type { Settings } from '@shared/types'

let dir: string
let store: MemoryStore

beforeEach(() => {
  prompts.length = 0
  dir = mkdtempSync(join(tmpdir(), 'va-playbooks-agent-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const template = (): Playbook => {
  const r = parsePlaybook(TEMPLATES[0]!.id, TEMPLATES[0]!.text)
  if (!r.ok) throw new Error('template does not parse')
  return r.playbook
}

const make = (settings: Settings, playbooks: () => Playbook[]) => {
  const traces: Array<Record<string, unknown>> = []
  const agent = new Agent({
    store,
    settings: () => settings,
    keys: { keysFor: (p: string) => (p === 'anthropic' ? ['test-key'] : []) },
    customStyles: () => [],
    skills: () => [],
    playbooks,
    mcp: { enabled: () => false, tools: () => ({}) } as never,
    search: { configured: () => false } as never,
    ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck: () => undefined },
    emit: () => undefined,
    emitAudio: () => undefined,
    cancelAudio: () => undefined,
    log: () => undefined,
    trace: (e) => traces.push(e)
  })
  const turn = async (text: string): Promise<void> => {
    const before = prompts.length
    void agent.send(text)
    await vi.waitFor(() => expect(prompts.length).toBe(before + 1))
  }
  return { agent, traces, turn }
}

describe('Agent: playbooks', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, playbooks: { ...DEFAULT_SETTINGS.playbooks, longMessageChars: 200 } }

  it('adds a fired playbook to that reply only, and traces it under the turn', async () => {
    const { agent, traces, turn } = make(settings, () => [template()])
    await turn('a short question')
    expect(prompts[0]!.live).not.toContain('Playbooks for this reply')

    await turn(`So ${'I have been thinking about a lot of things and '.repeat(8)}that is it.`)
    expect(prompts[1]!.live).toContain('Playbooks for this reply')
    expect(prompts[1]!.live).toContain('- Break down long messages (goal:')
    // the stable, cached half never changes because of a playbook
    expect(prompts[1]!.stable).toBe(prompts[0]!.stable)

    const start = traces.findLastIndex((t) => t.ev === 'turn.start')
    expect(traces[start]!.playbooks).toEqual(['long-message-breakdown'])
    const fired = traces.findIndex((t) => t.ev === 'trigger.fired')
    expect(fired).toBeGreaterThan(start)
    expect(traces[fired]).toMatchObject({ id: 'long-message-breakdown', turn: traces[start]!.turn })
    expect(String(traces[fired]!.why)).toContain('tuning.longMessageChars 200')

    // the user's message carries the firing, for the chip under it, and it is saved with the conversation
    const saved = store.messages(agent.currentSessionId).filter((m) => m.role === 'user')
    expect(saved[0]!.playbooks).toBeUndefined()
    expect(saved[1]!.playbooks).toEqual([{ id: 'long-message-breakdown', title: 'Break down long messages', why: expect.stringContaining('chars > tuning.longMessageChars') }])
  })

  it('uses none when maxInjected is 0, and a throwing source never costs the reply', async () => {
    const off = make({ ...settings, playbooks: { ...settings.playbooks, maxInjected: 0 } }, () => [template()])
    await off.turn('x'.repeat(400))
    expect(prompts[0]!.live).not.toContain('Playbooks for this reply')

    const broken = make(settings, () => {
      throw new Error('disk gone')
    })
    await broken.turn('x'.repeat(400))
    expect(prompts[1]!.live).not.toContain('Playbooks for this reply')
  })
})
