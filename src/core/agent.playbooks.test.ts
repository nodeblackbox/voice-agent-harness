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
import { JevClient } from './jev/client'
import type { PlaybookAdmin } from './tools/playbooks'
import type { Settings } from '@shared/types'

let dir: string
let store: MemoryStore

beforeEach(() => {
  prompts.length = 0
  dir = mkdtempSync(join(tmpdir(), 'va-playbooks-agent-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

const agents: Agent[] = []
afterEach(() => {
  // stop each agent's timers (the chat flush) before the database they write to goes away
  for (const a of agents.splice(0)) a.shutdown()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const template = (): Playbook => {
  const r = parsePlaybook(TEMPLATES[0]!.id, TEMPLATES[0]!.text)
  if (!r.ok) throw new Error('template does not parse')
  return r.playbook
}

const make = (settings: Settings, playbooks: () => Playbook[], jev?: JevClient, playbookAdmin?: PlaybookAdmin) => {
  const traces: Array<Record<string, unknown>> = []
  const agent = new Agent({
    store,
    settings: () => settings,
    keys: { keysFor: (p: string) => (p === 'anthropic' ? ['test-key'] : []) },
    customStyles: () => [],
    skills: () => [],
    playbooks,
    jev,
    playbookAdmin,
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
    expect(saved[1]!.playbooks).toEqual([{ id: 'long-message-breakdown', title: 'Break down long messages', kind: 'playbook', why: expect.stringContaining('chars > tuning.longMessageChars') }])
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

  describe('with Jev', () => {
    const idea = (): Playbook => {
      const t = TEMPLATES.find((x) => x.id === 'idea-not-instruction')!
      const r = parsePlaybook(t.id, t.text)
      if (!r.ok) throw new Error('template does not parse')
      return r.playbook
    }
    const answer = (choice: string, confidence = 0.82) => ({
      model: 'jev-1.14.0',
      answers: { intent: { type: 'choice', choice, confidence, probabilities: { task: 0, question: 0, chat: 0, idea: 0, feedback: 0, [choice]: confidence, ...(choice === 'chat' ? {} : { chat: 1 - confidence }) } } },
      usage: { input_tokens: 400, output_tokens: 2 }
    })
    const client = (fetch: typeof globalThis.fetch) => new JevClient({ key: () => 'test-key', fetch })

    it('asks what kind of message it is, fires the idea playbook on "idea", and traces the request and answer', async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify(answer('idea'))))
      const { traces, turn } = make(settings, () => [idea(), template()], client(fetch as never))
      await turn('maybe we could have a spend tab one day')
      expect(fetch).toHaveBeenCalledTimes(1)
      const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
      expect(Object.keys(body.questions)).toEqual(['intent'])
      expect(body.state).toEqual({ latest: 'maybe we could have a spend tab one day' })
      expect(prompts[0]!.live).toContain('- Idea, not instruction (goal:')
      const evs = traces.map((t) => t.ev)
      expect(evs.indexOf('jev.request')).toBeGreaterThan(evs.indexOf('turn.start'))
      expect(traces.find((t) => t.ev === 'jev.answer')).toMatchObject({ name: 'intent', answer: 'idea', p: 0.82 })
      expect(traces.find((t) => t.ev === 'trigger.fired')).toMatchObject({ id: 'idea-not-instruction', why: 'when intent == "idea" (intent "idea" at 0.82)' })
    })

    it('does not fire on another reading, or below the confidence floor', async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify(answer('task'))))
      const { turn } = make(settings, () => [idea()], client(fetch as never))
      await turn('add a spend tab')
      expect(prompts[0]!.live).not.toContain('Playbooks for this reply')
      fetch.mockImplementation(async () => new Response(JSON.stringify(answer('idea', 0.45))))
      await turn('hmm, a spend tab?')
      expect(prompts[1]!.live).not.toContain('Playbooks for this reply')
    })

    it('lets the reply go ahead without it when Jev is slow, and says so', async () => {
      const slow = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))))
      const { traces, turn } = make({ ...settings, playbooks: { ...settings.playbooks, jevTimeoutMs: 100 } }, () => [idea()], client(slow as never))
      await turn('maybe a spend tab')
      expect(prompts[0]!.live).not.toContain('Playbooks for this reply')
      expect(traces.find((t) => t.ev === 'jev.timeout')).toMatchObject({ ms: 100, questions: ['intent'] })
    })

    it('asks nothing when no playbook needs Jev, when it is switched off, or without a key', async () => {
      const fetch = vi.fn(async () => new Response(JSON.stringify(answer('idea'))))
      await make(settings, () => [template()], client(fetch as never)).turn('hello')
      await make({ ...settings, playbooks: { ...settings.playbooks, useJev: false } }, () => [idea()], client(fetch as never)).turn('maybe x')
      await make(settings, () => [idea()], new JevClient({ key: () => '', fetch: fetch as never })).turn('maybe y')
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  it('offers the playbook tools and the rules for them only when playbooks can be edited', async () => {
    const admin: PlaybookAdmin = { state: () => ({ dir: '/d', playbooks: [], jev: 'no_key' }), save: vi.fn(), toggle: vi.fn(), delete: vi.fn(), undo: vi.fn() } as never
    await make(settings, () => [], undefined, admin).turn('from now on, whenever I say push the changes, offer to push')
    expect(prompts[0]!.stable).toContain('make it a playbook with playbook_write')
    await make(settings, () => []).turn('hello')
    expect(prompts[1]!.stable).not.toContain('playbook_write')
  })
})

