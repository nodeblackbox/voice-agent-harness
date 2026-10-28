/** Pure helpers for the Claude Code view: turn a session's event log into a timeline, file tree and stats. */
import type { CcEvent, CcFile } from '@shared/claude'

export interface ToolItem {
  type: 'tool'
  key: string
  t: number
  name: string
  /** The main argument in one line: a command, a path, a pattern. */
  detail: string
  input: Record<string, unknown>
  result?: { text: string; isError: boolean; t: number }
}
export type FeedItem =
  | ToolItem
  | { type: 'user' | 'text' | 'denied' | 'error' | 'interrupt' | 'status'; key: string; t: number; text: string }
  | { type: 'result'; key: string; t: number; text: string; repeat: boolean; durationMs?: number; costUsd?: number; turns?: number }

export type ToolFamily = 'shell' | 'write' | 'edit' | 'read' | 'search' | 'web' | 'plan' | 'todo' | 'ask' | 'agent' | 'other'

export function toolFamily(name: string): ToolFamily {
  if (name === 'Bash' || name === 'PowerShell' || name === 'BashOutput' || name === 'KillShell') return 'shell'
  if (name === 'Write') return 'write'
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit'
  if (name === 'Read' || name === 'NotebookRead') return 'read'
  if (name === 'Glob' || name === 'Grep' || name === 'LS' || name === 'ToolSearch') return 'search'
  if (name === 'WebFetch' || name === 'WebSearch') return 'web'
  if (name === 'EnterPlanMode' || name === 'ExitPlanMode') return 'plan'
  if (name === 'TodoWrite' || name.startsWith('Task') && name !== 'Task') return 'todo'
  if (name === 'AskUserQuestion') return 'ask'
  if (name === 'Agent' || name === 'Task') return 'agent'
  return 'other'
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

export function toolDetail(name: string, input: Record<string, unknown>): string {
  const v = str(input.command) || str(input.file_path) || str(input.notebook_path) || str(input.pattern) || str(input.url) || str(input.query) || str(input.description) || str(input.path)
  return v.split('\n')[0] ?? ''
}

/** Build the timeline. Tool outputs are folded into their call; a final result that repeats the last reply is flagged. */
export function buildFeed(events: CcEvent[]): FeedItem[] {
  const out: FeedItem[] = []
  const byId = new Map<string, ToolItem>()
  let lastText = ''
  events.forEach((e, i) => {
    const key = `${e.t}-${i}`
    if (e.kind === 'tool') {
      // older events (before rich logging) only carry "Name detail" in text
      const name = e.tool ?? e.text.split(' ')[0] ?? 'tool'
      const input = e.input ?? {}
      const item: ToolItem = { type: 'tool', key, t: e.t, name, input, detail: e.input ? toolDetail(name, input) : e.text.slice(name.length + 1) }
      if (e.toolId) byId.set(e.toolId, item)
      out.push(item)
    } else if (e.kind === 'tool_result') {
      const target = (e.toolId && byId.get(e.toolId)) || [...out].reverse().find((x): x is ToolItem => x.type === 'tool' && !x.result)
      if (target) target.result = { text: e.text, isError: !!e.isError, t: e.t }
    } else if (e.kind === 'result') {
      out.push({ type: 'result', key, t: e.t, text: e.text, repeat: !!lastText && e.text.trim() === lastText.trim(), durationMs: e.durationMs, costUsd: e.costUsd, turns: e.turns })
      lastText = ''
    } else {
      if (e.kind === 'text') lastText = e.text
      if (e.kind === 'user') lastText = ''
      out.push({ type: e.kind, key, t: e.t, text: e.text })
    }
  })
  return out
}

/** Workspace-relative, forward-slash form of a path a tool used; null when it is outside the workspace. */
export function relPath(p: string, workspace: string): string | null {
  const f = p.replace(/\\/g, '/')
  const w = workspace.replace(/\\/g, '/').replace(/\/+$/, '')
  if (f.toLowerCase().startsWith(w.toLowerCase() + '/')) return f.slice(w.length + 1)
  if (/^([a-z]:)?\//i.test(f)) return null
  return f.replace(/^\.\//, '')
}

export interface Touched { path: string; writes: number; edits: number; t: number }

/** Files this session created or changed, most recent first. */
export function touchedFiles(events: CcEvent[], workspace: string): Touched[] {
  const m = new Map<string, Touched>()
  for (const e of events) {
    if (e.kind !== 'tool' || !e.input) continue
    const fam = toolFamily(e.tool ?? '')
    if (fam !== 'write' && fam !== 'edit') continue
    const rel = relPath(str(e.input.file_path) || str(e.input.notebook_path), workspace)
    if (!rel) continue
    const cur = m.get(rel) ?? { path: rel, writes: 0, edits: 0, t: 0 }
    if (fam === 'write') cur.writes++
    else cur.edits++
    cur.t = e.t
    m.set(rel, cur)
  }
  return [...m.values()].sort((a, b) => b.t - a.t)
}

export interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }

/** The session's latest to-do list (from TodoWrite), if it made one. */
export function latestTodos(events: CcEvent[]): Todo[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind === 'tool' && e.tool === 'TodoWrite' && Array.isArray(e.input?.todos)) {
      return (e.input.todos as Record<string, unknown>[]).map((x) => ({
        content: str(x.content) || str(x.activeForm),
        status: x.status === 'completed' || x.status === 'in_progress' ? x.status : 'pending'
      }))
    }
  }
  return []
}

/** How many times each tool family was used, busiest first. */
export function toolStats(events: CcEvent[]): Array<{ family: ToolFamily; count: number }> {
  const m = new Map<ToolFamily, number>()
  for (const e of events) if (e.kind === 'tool') { const f = toolFamily(e.tool ?? e.text.split(' ')[0] ?? ''); m.set(f, (m.get(f) ?? 0) + 1) }
  return [...m].map(([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count)
}

/** When the current turn started (the last prompt), for an elapsed timer. */
export function turnStart(events: CcEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === 'user') return events[i]!.t
  return null
}

export interface TreeNode { name: string; path: string; dir: boolean; size: number; mtime: number; skipped?: boolean; children: TreeNode[] }

/** Nest a flat listing (parents always precede children in it, but order is not relied on). */
export function buildTree(files: CcFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', dir: true, size: 0, mtime: 0, children: [] }
  const dirs = new Map<string, TreeNode>([['', root]])
  const ensureDir = (p: string): TreeNode => {
    const hit = dirs.get(p)
    if (hit) return hit
    const i = p.lastIndexOf('/')
    const node: TreeNode = { name: p.slice(i + 1), path: p, dir: true, size: 0, mtime: 0, children: [] }
    ensureDir(i < 0 ? '' : p.slice(0, i)).children.push(node)
    dirs.set(p, node)
    return node
  }
  for (const f of files) {
    if (f.dir) Object.assign(ensureDir(f.path), { mtime: f.mtime, skipped: f.skipped })
    else {
      const i = f.path.lastIndexOf('/')
      ensureDir(i < 0 ? '' : f.path.slice(0, i)).children.push({ name: f.path.slice(i + 1), path: f.path, dir: false, size: f.size, mtime: f.mtime, children: [] })
    }
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    n.children.forEach(sort)
  }
  sort(root)
  return root.children
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
export const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
export const ago = (t: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - t) / 1000))
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}
export const ext = (p: string) => (p.includes('.') ? p.slice(p.lastIndexOf('.') + 1).toLowerCase() : '')
export const isImage = (p: string) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'avif', 'bmp'].includes(ext(p))
export const isVideo = (p: string) => ['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext(p))
export const isAudio = (p: string) => ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'].includes(ext(p))
export const isPdf = (p: string) => ext(p) === 'pdf'
/** Files the viewer shows as themselves (picture, player, document) rather than as text. */
export const isMedia = (p: string) => isImage(p) || isVideo(p) || isAudio(p)
export const isHtml = (p: string) => ['html', 'htm'].includes(ext(p))
/** URL that serves a workspace file through the main process (`ccws://` protocol). */
export const wsUrl = (id: string, rel: string) => `ccws://${id}/${rel.split('/').map(encodeURIComponent).join('/')}`
