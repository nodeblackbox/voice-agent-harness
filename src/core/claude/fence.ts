/**
 * Workspace fence for Claude Code sessions. Pure policy: given a tool call, allow it, ask the user, or deny it.
 * The SDK's own sandbox is macOS/Linux only, so on Windows this is the real gate. It is wired in as a
 * PreToolUse hook (lab: a denying hook is the gate that holds; an 'ask' from the hook reaches canUseTool
 * with the reason, so the manager turns it into a spoken approval).
 *
 * Two policies:
 *  - fenced (plan / ask / auto modes): the session's folder (plus scratch roots such as the temp dir) is
 *    free; stepping outside it, deleting, pushing and the like ask the user first.
 *  - bypass: everything runs, except that a delete reaching outside the folder still asks.
 * Catastrophic, machine-level commands (wiping a disk, shutting down) are denied in every mode.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** allow, or not; `ask` = the user may approve it (a spoken yes/no), otherwise it is refused outright. */
export type FenceVerdict = { allow: true } | { allow: false; reason: string; ask?: boolean }

export interface FenceOptions {
  /** Absolute workspace root the session is pinned to. */
  root: string
  /** The shell's current folder (the hook reports it; it follows `cd`). Relative paths resolve against it. */
  cwd?: string
  /** Other folders the session may use freely (temp dir, Claude Code's plan files). */
  extra?: string[]
  /** 'bypass' = no questions except deletes reaching outside the folder. Default 'fenced'. */
  policy?: 'fenced' | 'bypass'
  /** Injectable for tests; resolves symlinks of the deepest existing ancestor. */
  realpath?: (p: string) => string
  /** Injectable for tests: environment used to expand $env:X, %X%, $HOME. */
  env?: Record<string, string | undefined>
}

/** Folders every session may use besides its own: the temp dir (background task output) and plan files. */
export function scratchRoots(): string[] {
  return [os.tmpdir(), path.join(os.homedir(), '.claude', 'plans')]
}

/** Tools that cannot touch the filesystem or run code outside the model sandbox. */
const SAFE_TOOLS = new Set([
  'TodoWrite', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'WebSearch', 'WebFetch',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput', 'ToolSearch', 'Agent', 'Task',
])
/** Tools that schedule work beyond the session; never, even in bypass. */
const NEVER_TOOLS = new Set(['CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger'])
/** Tools whose input carries a filesystem path. */
const PATH_FIELD: Record<string, string> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path',
}

/** Machine-level damage: refused in every mode. */
const asCommand = (w: string) => new RegExp(`(^|[\\s;&|(])${w}(?=$|[\\s;&|)])`, 'i') // a command word, not `app.shutdown()`
const CATASTROPHIC = [
  /(^|[\s;&|(])format(\.com)?\s+[a-z]:/i, asCommand('format-volume'), asCommand('clear-disk'), asCommand('initialize-disk'), asCommand('remove-partition'),
  asCommand('diskpart(\\.exe)?'), asCommand('mkfs(\\.\\w+)?'), /(^|[\s;&|(])dd\s[^|;&]*\bof=\/dev\//i, asCommand('shutdown(\\.exe)?'), asCommand('(restart|stop)-computer'),
  asCommand('bcdedit(\\.exe)?'), /(^|[\s;&|(])cipher(\.exe)?\s+\/w\b/i, /(^|[\s;&|(])vssadmin\s[^|;&]*\bdelete\b/i,
]
/** Commands that delete files. */
const DELETE_VERBS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri'])
/** Risky but sometimes wanted: the user decides (fenced policy). */
const RISKY_VERBS = new Set([...DELETE_VERBS, 'takeown', 'icacls', 'iex', 'invoke-expression', 'set-executionpolicy'])
const RISKY = [
  /\bgit\s+(push|clean)\b/i, /\bgit\s+reset\s+--hard\b/i, /\bgit\s+branch\s+-D\b/, /\bgit\s+stash\s+(drop|clear)\b/i,
  /\bnpm\s+(publish|login|adduser)\b/i, /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(sh|bash|pwsh|powershell|iex)\b/i,
  /\breg(\.exe)?\s+(delete|add|import)\b/i,
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

/** True when `target` is the root or inside it, after resolving `..` and symlinks. Relative = against `cwd` or the root. */
export function insideRoot(target: string, opts: FenceOptions): boolean {
  if (/^\\\\/.test(target)) return false // UNC / device paths
  const real = opts.realpath ?? defaultRealpath
  const root = norm(real(opts.root))
  const abs = path.isAbsolute(target) ? target : path.join(opts.cwd ?? opts.root, target)
  const resolved = norm(real(abs))
  return resolved === root || resolved.startsWith(root + path.sep)
}

/** Inside the workspace or one of the scratch roots. */
function allowedPath(target: string, opts: FenceOptions): boolean {
  if (insideRoot(target, opts)) return true
  return (opts.extra ?? []).some((r) => insideRoot(target, { ...opts, root: r }))
}

/** Shell words: quotes are joined to their neighbours (`"$D"/x` is one word); `; | & ( ) < >` and backticks split. */
export function shellWords(cmd: string): string[] {
  const words: string[] = []
  let cur = ''
  let has = false
  const cut = () => { if (has) words.push(cur); cur = ''; has = false }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (c === '"' || c === "'") {
      const end = cmd.indexOf(c, i + 1)
      const stop = end < 0 ? cmd.length : end
      cur += cmd.slice(i + 1, stop)
      has = true
      i = stop
    } else if (/\s/.test(c) || ';|&()<>`'.includes(c)) cut()
    else { cur += c; has = true }
  }
  cut()
  return words
}

/**
 * Expand variables a path may use: assignments made earlier in the same command (bash `D=/x`, PowerShell
 * `$D = 'x'`), `$env:X`, `%X%`, `$HOME`, `~`. Returns null for a variable it cannot know, followed by a path.
 */
function expander(env: Record<string, string | undefined>) {
  const vars = new Map<string, string>()
  const home = env.USERPROFILE || env.HOME || os.homedir()
  const lookup = (name: string): string | undefined => {
    const k = name.toLowerCase()
    if (vars.has(k)) return vars.get(k)
    if (k === 'home') return home
    if (k === 'pwd') return undefined
    const hit = Object.keys(env).find((e) => e.toLowerCase() === k)
    return hit ? env[hit] : undefined
  }
  return {
    assign(name: string, value: string) { vars.set(name.toLowerCase(), value) },
    expand(w: string): string | null {
      let unknown = false
      let out = w
        .replace(/\$env:([A-Za-z_]\w*)/gi, (m, n: string) => lookup(n) ?? ((unknown = true), m))
        .replace(/%([A-Za-z_]\w*)%/g, (m, n: string) => lookup(n) ?? m)
        .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a: string | undefined, b: string | undefined) => lookup((a ?? b)!) ?? ((unknown = true), m))
      if (/^~(?=$|[\\/])/.test(out)) out = home + out.slice(1)
      // an unresolvable variable only matters when a path is built from it
      if (unknown && /[\\/]/.test(out)) return null
      return out
    },
  }
}

/** Turn a shell word into a filesystem path to check, or null when it is not one (flags, URLs, switches). */
function asPath(w: string, platform: NodeJS.Platform): string | null {
  if (!w || /^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return null // URL
  if (/^-/.test(w)) {
    // -Path:C:\x or --out=C:\x
    const m = /^-{1,2}[\w-]+[:=](.+)$/.exec(w)
    return m ? asPath(m[1]!, platform) : null
  }
  if (/^\/dev\/(null|stdout|stderr|tty)$/i.test(w) || /^nul$/i.test(w)) return null
  if (/^[a-z]:([\\/]|$)/i.test(w)) return w.length === 2 ? w + '\\' : w
  if (/^\\\\/.test(w)) return w
  if (/^[\\/]/.test(w)) {
    if (platform === 'win32') {
      if (/^\/[a-z?]{1,2}$/i.test(w)) return null // a cmd switch such as /s, /q, /c
      const msys = /^\/([a-z])(\/.*)?$/i.exec(w) // Git Bash: /d/Downloads -> D:\Downloads
      if (msys) return `${msys[1]!.toUpperCase()}:${(msys[2] ?? '\\').replace(/\//g, '\\')}`
      const tmp = /^\/tmp(\/.*)?$/i.exec(w)
      if (tmp) return path.join(os.tmpdir(), tmp[1] ?? '')
    }
    return w
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(w)) return w
  return null
}

function checkShell(toolName: string, cmd: string, opts: FenceOptions): FenceVerdict {
  const bypass = opts.policy === 'bypass'
  if (!cmd.trim()) return { allow: false, reason: 'empty command' }
  for (const re of CATASTROPHIC) {
    if (re.test(cmd)) return { allow: false, reason: `${toolName} blocked: machine-level command (${re.source}) is never allowed` }
  }
  const words = shellWords(cmd)
  const lower = words.map((w) => w.toLowerCase())
  const deletes = lower.some((w) => DELETE_VERBS.has(w)) || /\bgit\s+clean\b/i.test(cmd)

  // paths, with variables expanded
  const ex = expander(opts.env ?? process.env)
  const outside: string[] = []
  const roots: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const bashSet = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/s.exec(w)
    if (bashSet) { ex.assign(bashSet[1]!, ex.expand(bashSet[2]!) ?? bashSet[2]!); continue }
    const psVar = /^\$([A-Za-z_]\w*)$/.exec(w)
    if (psVar && words[i + 1] === '=' && words[i + 2] !== undefined) { ex.assign(psVar[1]!, ex.expand(words[i + 2]!) ?? words[i + 2]!); i += 2; continue }
    if (/^\$env:\w+$/i.test(w) && words[i + 1] === '=') { i += 2; continue } // setting an environment variable
    const e = ex.expand(w)
    if (e === null) { outside.push(w); continue }
    const p = asPath(e, process.platform)
    if (!p) continue
    if (/^([a-z]:[\\/]?|\/)$/i.test(p) || norm(p) === norm(os.homedir())) roots.push(p)
    if (!allowedPath(p, opts)) outside.push(p)
  }
  if (deletes && roots.length) return { allow: false, reason: `${toolName} blocked: deleting from ${roots[0]} (a drive or your home folder) is never allowed` }
  const here = opts.cwd && !allowedPath(opts.cwd, opts) ? opts.cwd : null

  if (bypass) {
    if (deletes && (outside.length || here)) return { allow: false, ask: true, reason: `${toolName}: deletes outside its folder (${outside[0] ?? here})` }
    return { allow: true }
  }
  const risky = lower.find((w) => RISKY_VERBS.has(w)) ?? RISKY.find((re) => re.test(cmd))?.source
  if (risky) return { allow: false, ask: true, reason: deletes ? `${toolName}: deletes files` : `${toolName}: risky command (${risky})` }
  if (outside.length) return { allow: false, ask: true, reason: `${toolName}: uses ${outside[0]}, outside its folder ${opts.root}` }
  if (here) return { allow: false, ask: true, reason: `${toolName}: runs in ${here}, outside its folder ${opts.root}` }
  return { allow: true }
}

export function checkToolUse(toolName: string, input: Record<string, unknown>, opts: FenceOptions): FenceVerdict {
  const bypass = opts.policy === 'bypass'
  if (SAFE_TOOLS.has(toolName)) return { allow: true }
  if (NEVER_TOOLS.has(toolName)) return { allow: false, reason: `${toolName} is not available in a voice-managed session` }

  const field = PATH_FIELD[toolName]
  if (field) {
    const p = input[field]
    // Glob/Grep default to cwd (the workspace) when no path is given.
    if (p == null || p === '') return field === 'path' ? { allow: true } : { allow: false, reason: `${toolName} needs a ${field}` }
    if (typeof p !== 'string') return { allow: false, reason: `${toolName}: bad ${field}` }
    if (bypass || allowedPath(p, opts)) return { allow: true }
    return { allow: false, ask: true, reason: `${toolName}: ${p} is outside its folder ${opts.root}` }
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') return checkShell(toolName, typeof input.command === 'string' ? input.command : '', opts)

  // MCP connectors and anything unknown: only when the user chose bypass.
  if (bypass) return { allow: true }
  return { allow: false, reason: `${toolName} is not permitted in a voice-managed session (only in Bypass mode)` }
}
