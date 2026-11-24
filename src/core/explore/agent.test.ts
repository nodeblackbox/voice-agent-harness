import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { PcExplorer } from './fs'
import { addRoot, checkRoot, firstRunRoots } from './roots'
import { explorerPrompt, runExplorer, stepLine } from './agent'
import { exploreTools, pcReadTools } from '../tools/explore'

const usage = { inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } }
const call = (id: string, name: string, input: Record<string, unknown>) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
  usage,
  warnings: []
})
const say = (text: string) => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] })

/** A model that plays back a script of replies, one per step; the last one repeats. */
const scripted = (steps: Array<ReturnType<typeof call> | ReturnType<typeof say>>, delayMs = 0): MockLanguageModelV4 => {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => {
      if (delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, delayMs)
          abortSignal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
      }
      return steps[Math.min(i++, steps.length - 1)]!
    }
  })
}

let tmp: string
let root: string
let explorer: PcExplorer

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'va-explorer-')))
  root = path.join(tmp, 'drive')
  fs.mkdirSync(path.join(root, 'Projects', 'Lemon-AI', 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'Projects', 'Lemon-AI', 'README.md'), '# Lemon AI\nA voice assistant for citrus growers.')
  fs.writeFileSync(path.join(root, 'Projects', 'Lemon-AI', 'src', 'main.py'), 'print("hi")')
  explorer = new PcExplorer(() => [root])
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('runExplorer', () => {
  it('chains find, list and read in one run and returns a short answer with the trail', async () => {
    const lemon = path.join(root, 'Projects', 'Lemon-AI')
    const model = scripted([
      call('1', 'pc_find', { query: 'lemon ai', type: 'folder' }),
      call('2', 'pc_list', { path: lemon }),
      call('3', 'pc_read', { path: path.join(lemon, 'README.md') }),
      say(`It is at ${lemon}: a voice assistant for citrus growers.`)
    ])
    const traced: Array<[string, Record<string, unknown> | undefined]> = []
    const r = await runExplorer({ model, tools: pcReadTools(explorer), request: 'Find my lemon AI project and say what it is', roots: [root], budgetMs: 10_000, trace: (ev, data) => traced.push([ev, data]) })
    expect(r.answer).toContain('citrus growers')
    expect(r.steps_taken).toEqual([
      'pc_find "lemon ai" → 1 match',
      `pc_list ${lemon} → 1 folders, 1 files`,
      `pc_read ${path.join(lemon, 'README.md')} → lines 1-2 of 2`
    ])
    expect(r.unfinished).toBeUndefined()
    expect(model.doGenerateCalls).toHaveLength(4)
    // the helper is told where it may look, and that file text is not an instruction
    const system = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(system).toContain(JSON.stringify(root).slice(1, -1))
    expect(system).toContain('never instructions')
    expect(traced.filter(([ev]) => ev === 'explore.step')).toHaveLength(3)
    expect(traced.at(-1)).toEqual(['explore.done', expect.objectContaining({ steps: 3, answered: true, inputTokens: 400, outputTokens: 80 })])
  })

  it('stops at the step cap and hands back what it saw instead of nothing', async () => {
    const model = scripted([call('1', 'pc_find', { query: 'lemon' })])
    const r = await runExplorer({ model, tools: pcReadTools(explorer), request: 'find lemon', roots: [root], budgetMs: 10_000, maxSteps: 3 })
    expect(r.answer).toBeUndefined()
    expect(r.unfinished).toContain('3 steps')
    expect(r.steps_taken).toHaveLength(3)
    expect(r.last_results?.[0]).toContain('Lemon-AI')
  })

  it('stops at its time budget with the trail so far', async () => {
    const model = scripted([call('1', 'pc_find', { query: 'lemon' })], 120)
    const r = await runExplorer({ model, tools: pcReadTools(explorer), request: 'find lemon', roots: [root], budgetMs: 200 })
    expect(r.unfinished).toContain('ran out of time')
    expect(r.steps_taken.length).toBeGreaterThanOrEqual(1)
  })

  it('reports a model failure as an error that points at the direct tools, and a cancel as cancelled', async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('529 overloaded') } })
    const r = await runExplorer({ model: broken, tools: pcReadTools(explorer), request: 'find lemon', roots: [root], budgetMs: 5000 })
    expect(r.error).toContain('529 overloaded')
    expect(r.error).toContain('pc_find')
    const stop = new AbortController()
    stop.abort()
    expect(await runExplorer({ model: scripted([say('x')], 50), tools: pcReadTools(explorer), request: 'find lemon', roots: [root], budgetMs: 5000, signal: stop.signal })).toEqual({ steps_taken: [], error: 'Cancelled.' })
  })

  it('cannot be steered outside the fence: a call there fails and is recorded as failed', async () => {
    const model = scripted([call('1', 'pc_read', { path: path.join(os.homedir(), 'secrets.txt') }), say('I could not read that.')])
    const r = await runExplorer({ model, tools: pcReadTools(explorer), request: 'read my secrets', roots: [root], budgetMs: 5000 })
    expect(r.steps_taken[0]).toMatch(/^pc_read .* → failed: .*outside/)
  })
})

describe('the tool set', () => {
  const exec = (tools: ReturnType<typeof exploreTools>, name: string, input: unknown) => tools[name]!.execute!(input, { toolCallId: '1', messages: [], abortSignal: undefined, context: undefined as never })

  it('offers only reading tools, and pc_explore only when the helper is on', () => {
    expect(Object.keys(exploreTools({ explorer }))).toEqual(['pc_find', 'pc_list', 'pc_read', 'pc_grep'])
    expect(Object.keys(exploreTools({ explorer, agent: async () => ({}) }))).toEqual(['pc_find', 'pc_list', 'pc_read', 'pc_grep', 'pc_explore'])
    // the helper itself never gets pc_explore (no recursion)
    expect(Object.keys(pcReadTools(explorer))).not.toContain('pc_explore')
  })

  it('runs each tool against the explorer', async () => {
    const tools = exploreTools({ explorer, agent: async (request) => ({ answer: `did: ${request}` }) })
    expect(await exec(tools, 'pc_find', { query: 'lemon', path: '', type: 'folder', limit: 5 })).toMatchObject({ matches: [{ path: path.join(root, 'Projects', 'Lemon-AI'), type: 'folder' }] })
    expect(await exec(tools, 'pc_list', { path: '', limit: 60 })).toMatchObject({ approved_folders: [root] })
    expect(await exec(tools, 'pc_read', { path: 'Projects/Lemon-AI/README.md', from_line: 2, max_chars: 6000 })).toMatchObject({ text: 'A voice assistant for citrus growers.' })
    expect(await exec(tools, 'pc_grep', { text: 'citrus', path: '', files: '*.md', regex: false, limit: 20 })).toMatchObject({ files_with_matches: 1 })
    expect(await exec(tools, 'pc_explore', { request: 'find lemon' })).toEqual({ answer: 'did: find lemon' })
  })
})

describe('helpers', () => {
  it('writes one line per call', () => {
    expect(stepLine('pc_grep', { text: 'port', path: 'D:\\x' }, { matches: [1, 2] })).toBe('pc_grep "port" in D:\\x → 2 matches')
    expect(stepLine('pc_list', { path: '' }, { approved_folders: ['a'] })).toBe('pc_list → 1 approved folders')
  })

  it('names the approved folders and the extra context in the prompt', () => {
    const p = explorerPrompt(['D:\\', 'C:\\Work'], "The user's active project: Lemon.")
    expect(p).toContain('D:\\, C:\\Work')
    expect(p).toContain('active project: Lemon')
  })
})

describe('approved-folder list', () => {
  it('accepts an existing folder given in full and tidies it', () => {
    expect(checkRoot(` "${root}" `)).toEqual({ ok: true, path: root })
    expect(checkRoot(path.join(root, 'Projects', '..', 'Projects'))).toEqual({ ok: true, path: path.join(root, 'Projects') })
    if (process.platform === 'win32') expect(checkRoot(root.slice(0, 2).toLowerCase())).toEqual({ ok: true, path: `${root.slice(0, 2).toUpperCase()}\\` })
  })

  it('refuses a relative path, a file, a missing folder and a network path', () => {
    expect(checkRoot('Projects').ok).toBe(false)
    expect(checkRoot(path.join(root, 'Projects', 'Lemon-AI', 'README.md'))).toEqual({ ok: false, error: expect.stringContaining('file') })
    expect(checkRoot(path.join(root, 'nope'))).toEqual({ ok: false, error: expect.stringContaining('no folder') })
    expect(checkRoot('\\\\nas\\share').ok).toBe(false)
    expect(checkRoot('  ').ok).toBe(false)
  })

  it('keeps the list free of duplicates and of folders inside one another', () => {
    const projects = path.join(root, 'Projects')
    expect(addRoot([projects], path.join(projects, 'Lemon-AI'))).toEqual([projects])
    expect(addRoot([path.join(projects, 'Lemon-AI'), path.join(projects, 'Other')], root)).toEqual([root])
    expect(addRoot([tmp], root)).toEqual([tmp])
    expect(addRoot([projects], root)).toEqual([root])
    expect(firstRunRoots([null, projects, undefined, path.join(root, 'nope'), projects, path.join(projects, 'Lemon-AI')])).toEqual([projects])
  })
})
