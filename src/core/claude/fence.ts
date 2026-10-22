/**
 * Workspace fence for Claude Code sessions. Pure policy: given a tool call, decide allow or deny.
 * The SDK's own sandbox is macOS/Linux only, so on Windows this is the real gate. It is wired in as a
 * PreToolUse hook (a denying hook is the only gate the lab confirmed holds; `allowedTools` merely
 * pre-approves).
 *
 * Deliberately conservative: when unsure, deny. A denied call comes back to the model with the reason,
 * so it can adapt, and the manager can turn it into a spoken approval request.
 */
import fs from 'node:fs'
import path from 'node:path'

export type FenceVerdict = { allow: true } | { allow: false; reason: string }

export interface FenceOptions {
  /** Absolute workspace root the session is pinned to. */
  root: string
  /** Injectable for tests; resolves symlinks of the deepest existing ancestor. */
  realpath?: (p: string) => string
}

/** Tools that cannot touch the filesystem or run code outside the model sandbox. */
const SAFE_TOOLS = new Set([
  'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'ToolSearch',
])
/** Tools whose input carries a filesystem path. */
const PATH_FIELD: Record<string, string> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path',
}

const DESTRUCTIVE = [
  /\brm\b/i, /\brmdir\b/i, /\brd\b/i, /\bdel\b/i, /\berase\b/i, /\bremove-item\b/i, /\bformat\b/i,
  /\bdiskpart\b/i, /\bmkfs\b/i, /\bshutdown\b/i, /\brestart-computer\b/i, /\breg\s+(delete|add)\b/i,
  /\bgit\s+(clean|push|reset\s+--hard)\b/i, /\btakeown\b/i, /\bicacls\b/i, /\bmove-item\b/i,
  /\bnpm\s+(publish|login)\b/i, /\bcurl\b.*\|\s*(sh|bash|pwsh|powershell)/i, /\binvoke-expression\b|\biex\b/i,
]

const defaultRealpath = (p: string): string => {
  let cur = path.resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return path.resolve(p)
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase()

/** True when `target` is the root or inside it, after resolving `..` and symlinks. */
export function insideRoot(target: string, opts: FenceOptions): boolean {
  if (/^\\\\/.test(target)) return false // UNC / device paths
  const real = opts.realpath ?? defaultRealpath
  const root = norm(real(opts.root))
  const abs = path.isAbsolute(target) ? target : path.join(opts.root, target)
  const resolved = norm(real(abs))
  return resolved === root || resolved.startsWith(root + path.sep)
}

/** Pull path-like tokens out of a shell command so each can be checked. */
function pathTokens(cmd: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) {
    const t = (m[1] ?? m[2] ?? m[3] ?? '').replace(/^[<>=]+|[;&|)]+$/g, '')
    if (/^[a-z]:[\\/]/i.test(t) || /^[\\/]/.test(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t) || /^~|%[a-z_]+%|\$env:|\$home/i.test(t)) out.push(t)
  }
  return out
}

export function checkToolUse(toolName: string, input: Record<string, unknown>, opts: FenceOptions): FenceVerdict {
  if (SAFE_TOOLS.has(toolName)) return { allow: true }

  const field = PATH_FIELD[toolName]
  if (field) {
    const p = input[field]
    // Glob/Grep default to cwd (the workspace) when no path is given.
    if (p == null || p === '') return field === 'path' ? { allow: true } : { allow: false, reason: `${toolName} needs a ${field}` }
    if (typeof p !== 'string') return { allow: false, reason: `${toolName}: bad ${field}` }
    return insideRoot(p, opts) ? { allow: true } : { allow: false, reason: `${toolName} blocked: ${p} is outside the workspace ${opts.root}` }
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    if (!cmd.trim()) return { allow: false, reason: 'empty command' }
    for (const re of DESTRUCTIVE) {
      if (re.test(cmd)) return { allow: false, reason: `${toolName} blocked: destructive or system-level command (${re.source})` }
    }
    for (const t of pathTokens(cmd)) {
      if (/^~|%[a-z_]+%|\$env:|\$home/i.test(t) || !insideRoot(t, opts)) {
        return { allow: false, reason: `${toolName} blocked: path ${t} is outside the workspace ${opts.root}` }
      }
    }
    return { allow: true }
  }

  // Subagents inherit the same hook, so spawning one is fine; everything else (MCP connectors, unknown) is denied.
  if (toolName === 'Agent' || toolName === 'Task') return { allow: true }
  return { allow: false, reason: `${toolName} is not permitted in a voice-managed session` }
}
