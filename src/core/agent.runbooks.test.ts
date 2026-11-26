import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

// capture each turn's system prompt without calling a model
const prompts: Array<{ stable: string; live: string }> = []
const toolNames: string[][] = []
vi.mock('./turn/runner', () => ({
  TurnRunner: class {
    constructor(deps: { system: { stable: string; live: string }; tools: Record<string, unknown> }) {
      prompts.push(deps.system)
      toolNames.push(Object.keys(deps.tools))
    }
    run(): Promise<never> {
      return new Promise(() => undefined)
    }
  }
}))

// the runbook's background model: a fixed task list, and "yes" to anything asked
const generated: string[] = []
vi.mock('ai', async (orig) => ({
  ...(await orig<typeof import('ai')>()),
  generateText: vi.fn(async ({ prompt }: { prompt: string }) => {
    generated.push(prompt)
    return { text: prompt.includes('List every concrete task') ? 'Add a spend tab\nPush the branch\n' : 'yes', usage: { inputTokens: 100, outputTokens: 10 } }
  })
}))

import { DEFAULT_SETTINGS } from '../main/services/settings'
import { Agent } from './agent'
import { MemoryStore } from './memory/store'
import { parsePlaybook, type Playbook } from './playbooks/schema'
import { TEMPLATES } from './playbooks/templates'
import type { RunbookRun, Settings } from '@shared/types'

let dir: string
let store: MemoryStore
const agents: Agent[] = []

beforeEach(() => {
  prompts.length = 0
  toolNames.length = 0
  generated.length = 0
  dir = mkdtempSync(join(tmpdir(), 'va-runbooks-agent-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

afterEach(() => {
  for (const a of agents.splice(0)) a.shutdown()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const template = (id: string): Playbook => {
  const r = parsePlaybook(id, TEMPLATES.find((t) => t.id === id)!.text)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.playbook
}

describe('Agent: runbooks', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, playbooks: { ...DEFAULT_SETTINGS.playbooks, longMessageChars: 200 } }

  it('starts a runbook from a long message, offers the tasks, and takes the next message as the reply', async () => {
    const saved = new Map<string, RunbookRun>()
    const agent = new Agent({
      store,
      settings: () => settings,
      keys: { keysFor: (p: string) => (p === 'anthropic' ? ['test-key'] : []) },
      customStyles: () => [],
      skills: () => [],
      playbooks: () => [template('brain-dump-to-tasks')],
      runbookStore: { save: (r) => saved.set(r.runId, structuredClone(r)), load: () => [] },
      mcp: { enabled: () => false, tools: () => ({}) } as never,
      search: { configured: () => false } as never,
      ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck: () => undefined },
      emit: () => undefined,
      emitAudio: () => undefined,
      cancelAudio: () => undefined,
      log: () => undefined,
      trace: () => undefined
    })
    agents.push(agent)
    const said = vi.spyOn(agent, 'announce').mockImplementation(() => undefined)

    void agent.send(`So today ${'I need to add a spend tab and then push the branch, '.repeat(6)}that is the plan.`)
    await vi.waitFor(() => expect(prompts.length).toBe(1))
    // the reply mentions the job and leaves its work to it
    expect(prompts[0]!.live).toContain('"Brain dump to tasks" has started in the background')
    expect(prompts[0]!.live).toContain('It is already handled: do not do that part yourself')
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).toBe('waiting'))
    expect(said).toHaveBeenCalledWith('From that last message I picked out 2 tasks:\n- Add a spend tab\n- Push the branch\n\nWant me to add them to your to-do list?')
    expect(generated[0]).toContain('that is the plan.')

    void agent.send('yes, add them')
    await vi.waitFor(() => expect(prompts.length).toBe(2))
    expect(prompts[1]!.live).toContain('may be the answer to a question from the background job "Brain dump to tasks"')
    // neither reply could save the tasks itself: the job does that
    expect(toolNames[0]).not.toContain('remember')
    expect(toolNames[1]).not.toContain('remember')
    expect(toolNames[1]).not.toContain('update_memory')
    expect(toolNames[1]).toContain('recall')
    await vi.waitFor(() => expect(agent.runbooks.list()[0]?.status).toBe('done'))
    const todos = store.list('global').filter((e) => e.kind === 'todo').map((e) => e.value)
    expect(todos.sort()).toEqual(['Add a spend tab', 'Push the branch'])
    expect([...saved.values()][0]!.status).toBe('done')
  })
})
