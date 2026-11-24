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
import type { Settings } from '@shared/types'

let dir: string
let store: MemoryStore

beforeEach(() => {
  prompts.length = 0
  dir = mkdtempSync(join(tmpdir(), 'va-models-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const agentWith = (current: () => Settings, keyed: string[] = ['anthropic']) =>
  new Agent({
    store,
    settings: current,
    keys: { keysFor: (p: string) => (keyed.includes(p) ? ['test-key'] : []) },
    customStyles: () => [],
    skills: () => [],
    mcp: { enabled: () => false, tools: () => ({}) } as never,
    search: { configured: () => false } as never,
    ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck: () => undefined },
    emit: () => undefined,
    emitAudio: () => undefined,
    cancelAudio: () => undefined,
    log: () => undefined,
    trace: () => undefined
  })

const modelsLine = (i: number): string => prompts[i]!.live.split('\n').find((l) => l.startsWith('- Chat model right now:')) ?? ''

const turn = async (agent: Agent, text: string): Promise<void> => {
  const before = prompts.length
  void agent.send(text)
  await vi.waitFor(() => expect(prompts.length).toBe(before + 1))
}

describe('Agent: the active models in the prompt', () => {
  it('shows the chat model, speech to text and text to speech, and the next turn follows a settings change', async () => {
    let settings: Settings = { ...DEFAULT_SETTINGS, modelId: 'anthropic:claude-haiku-5-5' }
    const agent = agentWith(() => settings)

    await turn(agent, 'which model are you?')
    expect(modelsLine(0)).toContain('Chat model right now: Claude Haiku 5.5 (Anthropic)')
    expect(modelsLine(0)).toContain(`Speech to text: ${DEFAULT_SETTINGS.stt.model}, running locally on this computer.`)
    expect(modelsLine(0)).toMatch(/Text to speech: \S/)

    // the user switches the chat model in Settings; no restart
    settings = { ...settings, modelId: 'anthropic:claude-sonnet-5-5' }
    await turn(agent, 'and now?')
    expect(modelsLine(1)).toContain('Chat model right now: Claude Sonnet 5.5 (Anthropic)')
    expect(modelsLine(1)).not.toContain('Claude Haiku 5.5 (Anthropic),')
  })

  it('names the fallback actually in use when no chat model is picked', async () => {
    const agent = agentWith(() => ({ ...DEFAULT_SETTINGS, modelId: '' }))
    await turn(agent, 'hi')
    expect(modelsLine(0)).toContain('Chat model right now: Claude Haiku 4.5 (Anthropic), the default because no chat model is picked in Settings')
  })

  it('names the stand-in when the picked model has no key', async () => {
    const agent = agentWith(() => ({ ...DEFAULT_SETTINGS, modelId: 'anthropic:claude-opus-5-5' }), ['openai'])
    await turn(agent, 'hi')
    expect(modelsLine(0)).toMatch(/Chat model right now: GPT-5 mini \(OpenAI\), standing in because Claude Opus 5\.5 has no API key/)
  })
})
