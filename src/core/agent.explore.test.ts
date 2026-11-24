import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolSet } from 'ai'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

// capture what each turn hands to the model (prompt and tools), without calling a model
const turns: Array<{ system: { stable: string; live: string }; tools: ToolSet }> = []
vi.mock('./turn/runner', () => ({
  TurnRunner: class {
    constructor(deps: { system: { stable: string; live: string }; tools: ToolSet }) {
      turns.push({ system: deps.system, tools: deps.tools })
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
let allowed: string

beforeEach(() => {
  turns.length = 0
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'va-agent-explore-')))
  store = new MemoryStore(join(dir, 'm.sqlite'))
  allowed = join(dir, 'allowed')
  mkdirSync(join(allowed, 'Lemon-AI'), { recursive: true })
  writeFileSync(join(allowed, 'Lemon-AI', 'README.md'), '# Lemon AI')
  writeFileSync(join(dir, 'outside.txt'), 'private')
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const agentWith = (current: () => Settings, appDir: string | null = null) =>
  new Agent({
    store,
    settings: current,
    keys: { keysFor: (p: string) => (p === 'anthropic' ? ['test-key'] : []) },
    customStyles: () => [],
    skills: () => [],
    mcp: { enabled: () => false, tools: () => ({}) } as never,
    search: { configured: () => false } as never,
    appDir: () => appDir,
    ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck: () => undefined },
    emit: () => undefined,
    emitAudio: () => undefined,
    cancelAudio: () => undefined,
    log: () => undefined,
    trace: () => undefined
  })

const turn = async (agent: Agent, text: string) => {
  const before = turns.length
  void agent.send(text)
  await vi.waitFor(() => expect(turns.length).toBe(before + 1))
  return turns.at(-1)!
}
const pcTools = (t: { tools: ToolSet }): string[] => Object.keys(t.tools).filter((n) => n.startsWith('pc_'))
const exec = (tools: ToolSet, name: string, input: unknown) => tools[name]!.execute!(input, { toolCallId: '1', messages: [], abortSignal: undefined, context: undefined as never })
// no flush timer: streamed message updates are saved at once, so nothing fires after a test closes the store
const base: Settings = { ...DEFAULT_SETTINGS, brain: { ...DEFAULT_SETTINGS.brain, uiFlushMs: 0 } }
const explore = (patch: Partial<Settings['explore']>): Settings => ({ ...base, explore: { enabled: true, agent: true, roots: [], seeded: true, ...patch } })

describe('Agent: read-only PC tools', () => {
  it('offers them next to the other tools once a folder is approved, with the rules for using them', async () => {
    const t = await turn(agentWith(() => explore({ roots: [allowed] })), 'find my lemon AI project')
    expect(pcTools(t)).toEqual(['pc_find', 'pc_list', 'pc_read', 'pc_grep', 'pc_explore'])
    expect(Object.keys(t.tools)).toContain('current_time')
    expect(t.system.stable).toContain("The user's PC (read-only)")
    expect(t.system.stable).toContain('goes to pc_explore in a single call')
    expect(t.system.stable).toMatch(/You have tools: .*pc_find, pc_list, pc_read, pc_grep, pc_explore/)
  })

  it('offers none when switched off or when no folder is approved', async () => {
    expect(pcTools(await turn(agentWith(() => explore({ roots: [allowed], enabled: false })), 'hi'))).toEqual([])
    const none = await turn(agentWith(() => explore({ roots: [] })), 'hi')
    expect(pcTools(none)).toEqual([])
    expect(none.system.stable).not.toContain("The user's PC")
  })

  it('leaves out the helper when it is off, and tells the model to chain the calls itself', async () => {
    const t = await turn(agentWith(() => explore({ roots: [allowed], agent: false })), 'hi')
    expect(pcTools(t)).toEqual(['pc_find', 'pc_list', 'pc_read', 'pc_grep'])
    expect(t.system.stable).toContain('Chain the calls yourself in the same turn')
    expect(t.system.stable).not.toContain('pc_explore')
  })

  it('reads inside the approved folder, refuses outside it, and follows a change of the list without a restart', async () => {
    let settings = explore({ roots: [allowed] })
    const agent = agentWith(() => settings)
    const t = await turn(agent, 'hi')
    expect(await exec(t.tools, 'pc_find', { query: 'lemon ai', path: '', type: 'folder', limit: 5 })).toMatchObject({ matches: [{ path: join(allowed, 'Lemon-AI') }] })
    expect(await exec(t.tools, 'pc_read', { path: join(dir, 'outside.txt'), from_line: 1, max_chars: 6000 })).toEqual({ error: expect.stringContaining('outside the folders') })
    expect(await exec(t.tools, 'pc_read', { path: join(allowed, '..', 'outside.txt'), from_line: 1, max_chars: 6000 })).toEqual({ error: expect.stringContaining('outside the folders') })
    // the owner removes the folder in Settings: the same tool objects stop reading it at once
    settings = explore({ roots: [join(dir, 'elsewhere')] })
    expect(await exec(t.tools, 'pc_read', { path: join(allowed, 'Lemon-AI', 'README.md'), from_line: 1, max_chars: 6000 })).toEqual({ error: expect.stringContaining('outside the folders') })
  })
})

describe('Agent: the active project', () => {
  it("is this app's own code, with its folder, when no project is picked", async () => {
    const t = await turn(agentWith(() => explore({ roots: [allowed] }), 'D:\\Code\\voice-agent'), 'change your settings page')
    expect(t.system.live).toContain('- Active project: this app itself (your own source code), in the folder D:\\Code\\voice-agent')
    expect(t.system.live).not.toContain('Your own source code (this app)')
  })

  it('is the picked project with its folder, and the app folder is still named', async () => {
    const p = { id: 'lemon', name: 'Lemon AI', path: 'D:\\Projects\\lemon-ai', createdAt: 1 }
    store.saveProject(p)
    const t = await turn(agentWith(() => ({ ...explore({ roots: [allowed] }), projectId: p.id }), 'D:\\Code\\voice-agent'), 'hi')
    expect(t.system.live).toContain('- Active project: Lemon AI, in the folder D:\\Projects\\lemon-ai\n- Your own source code (this app): the folder D:\\Code\\voice-agent')
  })

  it('is "none" for a packaged app with no project picked', async () => {
    const t = await turn(agentWith(() => base), 'hi')
    expect(t.system.live).toContain('- Active project: none\n')
  })
})
