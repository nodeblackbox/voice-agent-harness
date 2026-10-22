import { describe, expect, it } from 'vitest'
import type { CcEvent } from '@shared/claude'
import { ago, buildFeed, buildTree, fmtDuration, latestTodos, relPath, toolFamily, toolStats, touchedFiles, turnStart, wsUrl } from './feed'

const ev = (kind: CcEvent['kind'], text: string, extra: Partial<CcEvent> = {}, t = 1): CcEvent => ({ t, kind, text, ...extra })
const WS = 'D:\\ws\\slop'

describe('buildFeed', () => {
  it('folds tool output into its call by id, and flags a result that repeats the last reply', () => {
    const feed = buildFeed([
      ev('user', 'make it'),
      ev('tool', 'PowerShell ls', { tool: 'PowerShell', toolId: 'a', input: { command: 'ls\nmore' } }),
      ev('tool', 'Write x.html', { tool: 'Write', toolId: 'b', input: { file_path: 'x.html', content: '<p>' } }),
      ev('tool_result', 'ok b', { toolId: 'b' }),
      ev('tool_result', 'dir listing', { toolId: 'a', isError: true }),
      ev('text', 'All done.'),
      ev('result', 'All done.', { durationMs: 3000 })
    ])
    expect(feed.map((f) => f.type)).toEqual(['user', 'tool', 'tool', 'text', 'result'])
    expect(feed[1]).toMatchObject({ name: 'PowerShell', detail: 'ls', result: { text: 'dir listing', isError: true } })
    expect(feed[2]).toMatchObject({ name: 'Write', detail: 'x.html', result: { text: 'ok b' } })
    expect(feed[4]).toMatchObject({ repeat: true, durationMs: 3000 })
  })

  it('handles old text-only tool events and results without ids', () => {
    const feed = buildFeed([ev('tool', 'Write index.html'), ev('tool_result', 'done'), ev('result', 'Different summary')])
    expect(feed[0]).toMatchObject({ name: 'Write', detail: 'index.html', result: { text: 'done' } })
    expect(feed[1]).toMatchObject({ type: 'result', repeat: false })
  })
})

describe('session insights', () => {
  it('relPath keeps workspace files and rejects outside ones', () => {
    expect(relPath('D:\\ws\\slop\\src\\a.js', WS)).toBe('src/a.js')
    expect(relPath('d:/WS/slop/index.html', WS)).toBe('index.html')
    expect(relPath('./b.css', WS)).toBe('b.css')
    expect(relPath('C:\\Windows\\x', WS)).toBeNull()
  })

  it('lists touched files newest first with write/edit counts', () => {
    const t = touchedFiles([
      ev('tool', 'Write', { tool: 'Write', input: { file_path: `${WS}\\index.html` } }, 1),
      ev('tool', 'Edit', { tool: 'Edit', input: { file_path: 'style.css' } }, 2),
      ev('tool', 'Edit', { tool: 'Edit', input: { file_path: `${WS}\\index.html` } }, 3),
      ev('tool', 'Read', { tool: 'Read', input: { file_path: 'other.txt' } }, 4)
    ], WS)
    expect(t).toEqual([{ path: 'index.html', writes: 1, edits: 1, t: 3 }, { path: 'style.css', writes: 0, edits: 1, t: 2 }])
  })

  it('reads the latest todo list, tool stats and turn start', () => {
    const events = [
      ev('user', 'go', {}, 5),
      ev('tool', 'TodoWrite', { tool: 'TodoWrite', input: { todos: [{ content: 'old', status: 'pending' }] } }),
      ev('tool', 'TodoWrite', { tool: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { activeForm: 'c', status: 'weird' }] } }),
      ev('tool', 'Bash ls', { tool: 'Bash', input: {} })
    ]
    expect(latestTodos(events)).toEqual([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }])
    expect(toolStats(events)).toEqual([{ family: 'todo', count: 2 }, { family: 'shell', count: 1 }])
    expect(turnStart(events)).toBe(5)
    expect(toolFamily('MultiEdit')).toBe('edit')
  })
})

describe('tree and formatting', () => {
  it('nests a flat listing, folders first', () => {
    const tree = buildTree([
      { path: 'index.html', dir: false, size: 3, mtime: 1 },
      { path: 'src', dir: true, size: 0, mtime: 1 },
      { path: 'src/a.js', dir: false, size: 1, mtime: 1 },
      { path: 'node_modules', dir: true, size: 0, mtime: 1, skipped: true }
    ])
    expect(tree.map((n) => n.name)).toEqual(['node_modules', 'src', 'index.html'])
    expect(tree[1]!.children.map((n) => n.path)).toEqual(['src/a.js'])
    expect(tree[0]!.skipped).toBe(true)
  })

  it('formats durations, ages and workspace urls', () => {
    expect(fmtDuration(4200)).toBe('4s')
    expect(fmtDuration(125_000)).toBe('2m 05s')
    expect(ago(0, 90_000)).toBe('1m ago')
    expect(wsUrl('cc1-x', 'my dir/a b.html')).toBe('ccws://cc1-x/my%20dir/a%20b.html')
  })
})
