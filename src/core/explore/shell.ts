/**
 * The restricted terminal of the explorer module. It is not a shell: no command line ever reaches cmd, PowerShell or
 * bash. A line is split into words here, checked against an allowlist, and then either answered by this module's own
 * fenced file operations (ls, dir, cat, type, head, tail, grep, findstr, find, wc, pwd) or, for git only, run as one
 * program with an argument list.
 *
 * So there is nothing to block: a command that is not on the list does not exist. rm, del, rmdir, Remove-Item,
 * format, move, copy, curl, npm, pip and every other program are refused because they are not listed, and
 * `find -delete` or `find -exec` because those options are not listed either. Chaining (; & && ||), redirection
 * (> >> <), substitution ($ ` %VAR%) and anything else the parser does not fully understand is refused with the
 * reason, never guessed at. A pipe is allowed only into the text filters grep, findstr, head, tail, wc and sort,
 * which are answered here too.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isSecretName, redact, type PcExplorer } from './fs'

export type ShellResult = { ok: true; output: string } | { ok: false; refused: string } | { ok: false; error: string }

export interface ProcResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}
/** Runs one program with an argument list, never through a shell. Injectable for tests. */
export type Spawn = (file: string, args: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBytes: number; signal?: AbortSignal }) => Promise<ProcResult>

export interface ShellOptions {
  spawn?: Spawn
  /** Full path of git, or null when it is not installed. Default: looked up once on PATH. */
  git?: () => string | null
  timeoutMs?: number
  maxOutputChars?: number
}

export const SHELL_COMMANDS = ['ls', 'dir', 'cat', 'type', 'head', 'tail', 'grep', 'findstr', 'find', 'wc', 'pwd', 'git status', 'git log', 'git diff', 'git branch']
const FILTERS = new Set(['grep', 'findstr', 'head', 'tail', 'wc', 'sort'])
const ALIASES: Record<string, string> = { 'get-childitem': 'ls', gci: 'ls', 'get-content': 'cat', gc: 'cat', 'select-string': 'grep', sls: 'grep', 'get-location': 'pwd' }

/** Why the common dangerous commands are refused, for a clearer message; they are off the allowlist either way. */
const NEVER: Array<[RegExp, string]> = [
  [/^(rm|del|erase|rmdir|rd|remove-item|ri|unlink|shred|sdelete|format|diskpart|clear-content|clc|truncate)$/, 'deleting is never allowed'],
  [/^(mv|move|move-item|mi|ren|rename|rename-item|rni|cp|copy|copy-item|cpi|xcopy|robocopy|mklink|ln|touch|mkdir|md|new-item|ni|set-content|sc|add-content|ac|out-file|tee|chmod|chown|icacls|attrib|takeown)$/, 'moving, copying or creating files is not allowed here (a file can only be changed with the edit tool)'],
  [/^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|sftp|ftp|telnet|nc|ncat|ping|nslookup|net|netsh|start-bitstransfer|bitsadmin)$/, 'network commands are not allowed'],
  [/^(npm|npx|pnpm|yarn|bun|pip|pip3|pipx|uv|conda|choco|winget|scoop|apt|apt-get|brew|cargo|go|gem|dotnet|msiexec)$/, 'installing or running package managers is not allowed'],
  [/^(cmd|powershell|pwsh|bash|sh|zsh|wsl|python|python3|py|node|deno|ruby|perl|php|java|start|start-process|saps|invoke-expression|iex|call|runas|sudo|schtasks|reg|regedit|sc\.exe|taskkill|kill|stop-process|shutdown|restart-computer)$/, 'running programs or scripts is not allowed']
]

export type Parsed = { ok: true; stages: string[][] } | { ok: false; reason: string }

/**
 * Split a command line into pipeline stages of words. Quotes group words and nothing inside them is expanded;
 * every character that would mean something to a real shell is refused when it appears outside quotes.
 */
export function parseCommand(line: string): Parsed {
  const no = (reason: string): Parsed => ({ ok: false, reason })
  if (typeof line !== 'string' || !line.trim()) return no('empty command')
  if (line.length > 500) return no('the command is too long')
  if (/[\r\n\0\x00-\x08\x0b-\x1f]/.test(line)) return no('one command on one line only')
  const stages: string[][] = [[]]
  let cur = ''
  let has = false
  const cut = (): void => {
    if (has) stages.at(-1)!.push(cur)
    cur = ''
    has = false
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '"' || c === "'") {
      const end = line.indexOf(c, i + 1)
      if (end < 0) return no('a quote is not closed')
      const inner = line.slice(i + 1, end)
      if (c === '"' && /[$`]/.test(inner)) return no('$ and backticks are not allowed (nothing is expanded)')
      cur += inner
      has = true
      i = end
    } else if (/\s/.test(c)) cut()
    else if (c === '|') {
      if (line[i + 1] === '|') return no('chaining commands (||) is not allowed')
      cut()
      if (!stages.at(-1)!.length) return no('a pipe needs a command on both sides')
      stages.push([])
    } else if (c === ';' || c === '&') return no(`chaining commands (${c}) is not allowed: one command at a time`)
    else if (c === '>' || c === '<') return no(`redirection (${c}) is not allowed: nothing can be written or overwritten from here`)
    else if (c === '$' || c === '`' || c === '(' || c === ')' || c === '{' || c === '}') return no(`${c} is not allowed (no variables, sub-commands or blocks)`)
    else if (c === '%' && /^%[A-Za-z_]\w*%/.test(line.slice(i))) return no('%VARIABLES% are not expanded: write the path out')
    else if (c === '^') return no('^ is not allowed')
    else if (c === '~' && !has && /^~([\\/]|\s|$)/.test(line.slice(i))) return no('~ is not expanded: write the path out')
    else {
      cur += c
      has = true
    }
  }
  cut()
  if (!stages.at(-1)!.length) return no(stages.length > 1 ? 'a pipe needs a command on both sides' : 'empty command')
  if (stages.length > 3) return no('at most two pipes')
  return { ok: true, stages }
}

/** The command word as the allowlist knows it, or the reason it is refused. */
function commandName(word: string): { name: string } | { refused: string } {
  if (/[\\/:]/.test(word)) return { refused: `"${word}": commands are named, not given as a path` }
  let name = word.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')
  name = ALIASES[name] ?? name
  return { name }
}

const whyNot = (name: string): string => {
  const hit = NEVER.find(([re]) => re.test(name))
  return `"${name}" is not available: ${hit ? hit[1] : 'it is not on the list of allowed commands'}. Allowed: ${SHELL_COMMANDS.join(', ')}.`
}

const defaultSpawn: Spawn = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, maxBuffer: opts.maxBytes, windowsHide: true, shell: false, signal: opts.signal, encoding: 'utf8' }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (e && typeof e.code !== 'number' ? e.message : ''), timedOut: !!e?.killed })
    })
  })

let gitPath: string | null | undefined
/**
 * git's full path, from the folders on PATH that are absolute. Never a bare "git": Windows would look in the
 * folder the command runs in first, and a git.exe planted in a project would run.
 */
export function findGit(env: NodeJS.ProcessEnv = process.env): string | null {
  if (gitPath !== undefined) return gitPath
  const names = process.platform === 'win32' ? ['git.exe'] : ['git']
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue
    for (const n of names) {
      const p = path.join(dir, n)
      try {
        if (fs.statSync(p).isFile()) return (gitPath = p)
      } catch {
        // not here
      }
    }
  }
  return (gitPath = null)
}

const REV = /^[A-Za-z0-9][\w./~^@-]{0,120}$/
const GIT_FLAGS: Record<string, RegExp> = {
  status: /^(-s|-b|-sb|-bs|--short|--branch|--porcelain(=v[12])?|-uno|-uall|-unormal|--untracked-files=(no|normal|all)|--ahead-behind|--no-ahead-behind)$/,
  log: /^(--oneline|-\d{1,3}|-n\d{1,3}|--max-count=\d{1,3}|--stat|--shortstat|--name-only|--name-status|--graph|--all|--decorate|--no-decorate|--reverse|--follow|--no-merges|--merges|--first-parent|--abbrev-commit|-i|--(since|until|after|before)=[\w .:,/+-]{1,40}|--author=[\w .@<>+-]{1,60}|--grep=[\w .,:#@/+-]{1,80}|--date=(short|relative|iso|iso-strict|local|human)|--(pretty|format)=(oneline|short|medium|full|fuller))$/,
  diff: /^(--stat|--shortstat|--numstat|--name-only|--name-status|--cached|--staged)$/,
  branch: /^(-a|-r|-v|-vv|-av|-va|--all|--remotes|--list|--show-current|--verbose)$/
}

export class RestrictedShell {
  private readonly spawn: Spawn
  private readonly git: () => string | null
  private readonly timeoutMs: number
  private readonly maxChars: number

  constructor(
    private readonly ex: PcExplorer,
    opts: ShellOptions = {}
  ) {
    this.spawn = opts.spawn ?? defaultSpawn
    this.git = opts.git ?? (() => findGit())
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.maxChars = opts.maxOutputChars ?? 6000
  }

  /** Run one line in `cwd` (an approved folder; may be left out when there is exactly one). Never throws. */
  async run(line: string, cwdInput = '', signal?: AbortSignal): Promise<ShellResult> {
    const parsed = parseCommand(line)
    if (!parsed.ok) return { ok: false, refused: `Refused: ${parsed.reason}.` }
    // every stage is checked before anything runs
    const names: string[] = []
    for (const [i, stage] of parsed.stages.entries()) {
      const n = commandName(stage[0]!)
      if ('refused' in n) return { ok: false, refused: `Refused: ${n.refused}.` }
      if (i > 0 && !FILTERS.has(n.name)) return { ok: false, refused: `Refused: output can only be piped into ${[...FILTERS].join(', ')}, not "${n.name}".` }
      names.push(n.name)
    }
    const roots = this.ex.roots()
    if (!cwdInput.trim() && roots.length !== 1) return { ok: false, refused: 'Refused: say which folder to run in (cwd); there is more than one approved folder.' }
    const at = await this.ex.resolve(cwdInput.trim() || roots[0]!)
    if (!at.ok) return { ok: false, refused: `Refused: ${at.error}` }
    try {
      if (!(await fs.promises.stat(at.path)).isDirectory()) return { ok: false, error: `${at.path} is not a folder.` }
    } catch {
      return { ok: false, error: `There is no folder at ${at.path}.` }
    }
    let out: Step = await this.first(names[0]!, parsed.stages[0]!.slice(1), at.path, signal)
    for (let i = 1; i < parsed.stages.length && 'text' in out; i++) out = filter(names[i]!, parsed.stages[i]!.slice(1), out.text)
    if ('refused' in out) return { ok: false, refused: `Refused: ${out.refused}` }
    if ('error' in out) return { ok: false, error: out.error }
    const text = redact(out.text.trimEnd())
    return { ok: true, output: text.length > this.maxChars ? `${text.slice(0, this.maxChars)}\n[output cut at ${this.maxChars} characters]` : text || '(no output)' }
  }

  private async first(name: string, args: string[], cwd: string, signal?: AbortSignal): Promise<Step> {
    const abs = (p: string): string => (p === '.' ? cwd : /^([a-z]:|[\\/])/i.test(p) ? p : path.join(cwd, p))
    const { flags, rest } = split(args)
    const bad = (ok: RegExp): string | undefined => flags.find((f) => !ok.test(f))
    const unknown = (f: string): Step => ({ refused: `the option "${f}" of ${name} is not supported here.` })

    switch (name) {
      case 'pwd':
        return args.length ? { refused: 'pwd takes no arguments.' } : { text: cwd }

      case 'ls':
      case 'dir': {
        const f = bad(/^(-[lah1tFG]+|\/[abwonqd](:[\w-]*)?)$/i)
        if (f) return /^(-\w*R\w*|\/s)$/i.test(f) ? { refused: 'listing sub-folders too is not supported: use find with -name.' } : unknown(f)
        if (rest.length > 3) return { refused: 'list at most three folders at a time.' }
        if (rest.some((p) => /[*?]/.test(p))) return { refused: 'patterns are not expanded: use find -name "pattern".' }
        const parts: string[] = []
        for (const p of rest.length ? rest : ['.']) {
          const r = await this.ex.list(abs(p), 200)
          if (typeof r.error === 'string') return fail(r.error)
          const lines = [...(r.folders as string[]).map((d) => `${d}/`), ...(r.files as string[])]
          parts.push(`${rest.length > 1 ? `${String(r.path)}:\n` : ''}${lines.join('\n')}${r.not_shown ? `\n[${String(r.not_shown)} more not shown]` : ''}`)
        }
        return { text: parts.join('\n\n') }
      }

      case 'cat':
      case 'type':
      case 'head':
      case 'tail': {
        let n = name === 'head' || name === 'tail' ? 10 : 0
        const files: string[] = []
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!
          if (/^-\d{1,4}$/.test(a)) n = Number(a.slice(1))
          else if (a === '-n' && /^\d{1,4}$/.test(args[i + 1] ?? '') && (name === 'head' || name === 'tail')) n = Number(args[++i])
          else if (a === '-n' && name === 'cat') continue
          else if (/^-/.test(a)) return unknown(a)
          else files.push(a)
        }
        if (!files.length) return { refused: `${name} needs a file.` }
        if (files.length > 3) return { refused: 'read at most three files at a time.' }
        if (files.some((p) => /[*?]/.test(p))) return { refused: 'patterns are not expanded: name the file.' }
        const parts: string[] = []
        for (const p of files) {
          const r = await this.ex.read(abs(p), { maxChars: Math.floor(this.maxChars / files.length) })
          if (typeof r.error === 'string') return fail(r.error)
          let text = String(r.text)
          if (name === 'head') text = text.split('\n').slice(0, n).join('\n')
          else if (name === 'tail') {
            if (r.more) return { refused: 'that file is too long for tail here: read it in parts with the read tool (from_line).' }
            text = text.split('\n').slice(-n).join('\n')
          } else if (r.more) text += `\n[${String(r.more)}]`
          parts.push(files.length > 1 ? `==> ${String(r.path)} <==\n${text}` : text)
        }
        return { text: parts.join('\n\n') }
      }

      case 'wc': {
        if (flags.length !== 1 || flags[0] !== '-l' || rest.length !== 1) return { refused: 'only "wc -l file" is supported.' }
        const r = await this.ex.read(abs(rest[0]!), { maxChars: 200 })
        if (typeof r.error === 'string') return fail(r.error)
        const total = /of (more than )?(\d+)$/.exec(String(r.lines))
        return { text: `${total?.[1] ? 'more than ' : ''}${total?.[2] ?? '?'} ${String(r.path)}` }
      }

      case 'grep':
      case 'findstr': {
        const g = grepArgs(name, args)
        if ('refused' in g) return g
        if (!g.rest.length) return { refused: `${name} needs the text to look for.` }
        if (g.invert) return { refused: `${name} -v is only supported after a pipe.` }
        const [pattern, ...where] = g.rest as [string, ...string[]]
        if (where.length > 3) return { refused: 'search at most three places at a time.' }
        const parts: string[] = []
        for (const p of where.length ? where : ['.']) {
          const r = await this.ex.grep(pattern, { path: abs(p), regex: g.regex, caseSensitive: !g.ignoreCase, files: g.include, limit: 40, signal })
          if (typeof r.error === 'string') return fail(r.error)
          const m = r.matches as Array<{ file: string; line: number; text: string }>
          parts.push(g.filesOnly ? [...new Set(m.map((x) => x.file))].join('\n') : m.map((x) => `${x.file}:${x.line}: ${x.text}`).join('\n'))
          const note = (r.note ?? r.incomplete) as string | undefined
          if (note) parts.push(`[${note}]`)
        }
        return { text: parts.filter(Boolean).join('\n') }
      }

      case 'find': {
        let start = '.'
        let i = 0
        if (args[0] !== undefined && !args[0].startsWith('-')) start = args[i++]!
        let query = '*'
        let type: 'any' | 'folder' | 'file' = 'any'
        for (; i < args.length; i++) {
          const a = args[i]!
          const v = args[i + 1]
          if ((a === '-name' || a === '-iname') && v !== undefined) query = args[++i]!
          else if (a === '-type' && (v === 'f' || v === 'd')) type = args[++i] === 'f' ? 'file' : 'folder'
          else if (a === '-maxdepth' && /^\d+$/.test(v ?? '')) i++
          else if (/^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a)) return { refused: `find ${a} is never allowed: find can only look.` }
          else return { refused: `find understands only -name, -iname, -type f|d and -maxdepth here, not "${a}". (To search inside files use grep "text" folder.)` }
        }
        const r = await this.ex.find(query, { path: abs(start), type, limit: 50, signal })
        if (typeof r.error === 'string') return fail(r.error)
        const m = r.matches as Array<{ path: string; type: string }>
        return { text: [...m.map((x) => (x.type === 'folder' ? `${x.path}${path.sep}` : x.path)), r.more_matches ? `[${String(r.more_matches)} more matches]` : '', r.incomplete ? `[${String(r.incomplete)}]` : ''].filter(Boolean).join('\n') }
      }

      case 'git':
        return this.runGit(args, cwd, signal)

      default:
        return { refused: whyNot(name) }
    }
  }

  /** git status, log, diff (summaries) and branch (list), as a program with arguments; nothing that writes or fetches. */
  private async runGit(args: string[], cwd: string, signal?: AbortSignal): Promise<Step> {
    const sub = (args[0] ?? '').toLowerCase()
    const ok = GIT_FLAGS[sub]
    if (!ok) return { refused: `only git status, git log, git diff and git branch are available${sub ? `, not "git ${sub}"` : ''}.` }
    const dash = args.indexOf('--')
    const before = (dash < 0 ? args : args.slice(0, dash)).slice(1)
    const paths = dash < 0 ? [] : args.slice(dash + 1)
    const flags: string[] = []
    const revs: string[] = []
    for (let i = 0; i < before.length; i++) {
      let a = before[i]!
      if (a === '-n' && sub === 'log' && /^\d{1,3}$/.test(before[i + 1] ?? '')) a = `-n${before[++i]}`
      if (a.startsWith('-')) {
        if (!ok.test(a)) return { refused: `"git ${sub} ${a}" is not supported here${/^(-p|--patch|-S|-G|-L|-u|--output)/.test(a) ? ' (summaries only: use --stat or --name-status)' : ''}.` }
        flags.push(a)
      } else if (sub === 'log' || sub === 'diff') {
        if (!REV.test(a)) return { refused: `"${a}" is not a plain commit or branch name; put file paths after "--".` }
        revs.push(a)
      } else return { refused: `git ${sub} takes no "${a}" here.` }
    }
    if (paths.length && sub === 'branch') return { refused: 'git branch takes no paths.' }
    const checked: string[] = []
    for (const p of paths) {
      if (/[*?[\]:]/.test(p) || p.startsWith('-')) return { refused: `"${p}": name plain file paths after "--".` }
      const at = await this.ex.resolve(/^([a-z]:|[\\/])/i.test(p) ? p : path.join(cwd, p))
      if (!at.ok) return { refused: at.error }
      if (isSecretName(path.basename(at.path))) return { refused: `${path.basename(at.path)} usually holds passwords or keys; its history is not shown.` }
      checked.push(at.path)
    }

    // the repository must start inside the approved folder, and be an ordinary one
    const root = await this.repoTop(cwd)
    if ('refused' in root) return root
    const git = this.git()
    if (!git) return { error: 'git is not installed on this PC.' }

    if (sub === 'log' && !flags.some((f) => /^(-\d|-n\d|--max-count=)/.test(f))) flags.push('--max-count=30')
    if (sub === 'diff' && !flags.some((f) => /^--(stat|shortstat|numstat|name-only|name-status)$/.test(f))) flags.push('--stat')
    const argv = [
      '--no-pager', '--no-optional-locks',
      // settings a repository could use to make git start another program are overridden for this run
      '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'log.showSignature=false', '-c', 'color.ui=false', '-c', 'core.quotepath=false',
      sub,
      ...(sub === 'log' || sub === 'diff' ? ['--no-ext-diff', '--no-textconv'] : []),
      ...flags, ...revs,
      ...(checked.length ? ['--', ...checked] : [])
    ]
    const env: Record<string, string> = {}
    // git gets the few variables it needs to start, not the app's environment (which holds API keys)
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && /^(path|systemroot|windir|userprofile|home|homedrive|homepath|temp|tmp|lang|lc_all|appdata|localappdata|programfiles|programdata)$/i.test(k)) env[k] = v
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_ASKPASS: 'echo', GIT_CEILING_DIRECTORIES: path.dirname(root.top) })
    const r = await this.spawn(git, argv, { cwd, env, timeoutMs: this.timeoutMs, maxBytes: 512 * 1024, signal })
    if (r.timedOut) return { error: `git ${sub} was stopped after ${Math.round(this.timeoutMs / 1000)} seconds.` }
    if (r.code !== 0) return { error: `git ${sub} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' ').slice(0, 300) || `exit code ${String(r.code)}`}` }
    return { text: r.stdout }
  }

  /** The folder holding `.git`, walking up from `cwd` but never above the approved folder it is in. */
  private async repoTop(cwd: string): Promise<{ top: string } | { refused: string }> {
    const roots: string[] = []
    for (const r of this.ex.roots()) {
      const at = await this.ex.resolve(r)
      roots.push(at.ok ? at.path : r)
    }
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      const dot = path.join(dir, '.git')
      try {
        const st = await fs.promises.lstat(dot)
        if (st.isDirectory() && !st.isSymbolicLink()) return { top: dir }
        return { refused: `${dir} is a linked git checkout (its history lives in another folder), which is not read from here.` }
      } catch {
        // no .git here: go up
      }
      const atRoot = roots.some((r) => r.toLowerCase() === dir.toLowerCase())
      if (atRoot || path.dirname(dir) === dir) return { refused: `${cwd} is not inside a git repository that lies within the approved folders.` }
    }
  }
}

type Step = { text: string } | { refused: string } | { error: string }
const fail = (msg: string): Step => (/outside the folders|never read|credentials|device name|not allowed|valid path/.test(msg) ? { refused: msg } : { error: msg })

function split(args: string[]): { flags: string[]; rest: string[] } {
  const flags: string[] = []
  const rest: string[] = []
  // a Windows switch is /x or /x:value; a path that starts with a slash has more to it (/d/Projects)
  for (const a of args) (a.startsWith('-') && a !== '-' ? flags : /^\/[a-z](:[\w-]*)?$/i.test(a) ? flags : rest).push(a)
  return { flags, rest }
}

interface GrepArgs { ignoreCase: boolean; regex: boolean; filesOnly: boolean; invert: boolean; include: string; rest: string[] }
function grepArgs(name: string, args: string[]): GrepArgs | { refused: string } {
  const g: GrepArgs = { ignoreCase: false, regex: name === 'grep', filesOnly: false, invert: false, include: '', rest: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (name === 'findstr' && /^\/[a-z]$/i.test(a)) {
      const f = a[1]!.toLowerCase()
      if (f === 'i') g.ignoreCase = true
      else if (f === 'r') g.regex = true
      else if (f === 'm') g.filesOnly = true
      else if (f === 'v') g.invert = true
      else if (f !== 's' && f !== 'n' && f !== 'l') return { refused: `the option "${a}" of findstr is not supported here.` }
    } else if (name === 'findstr' && /^\/c:/i.test(a)) g.rest.unshift(a.slice(3))
    else if (/^--include=/.test(a)) g.include = a.slice(10)
    else if (a === '-e' && args[i + 1] !== undefined) g.rest.unshift(args[++i]!)
    else if (/^-[a-zA-Z]+$/.test(a)) {
      for (const f of a.slice(1)) {
        if (f === 'i') g.ignoreCase = true
        else if (f === 'F') g.regex = false
        else if (f === 'E' || f === 'P') g.regex = true
        else if (f === 'l') g.filesOnly = true
        else if (f === 'v') g.invert = true
        else if (!'rRnHIsh'.includes(f)) return { refused: `the option "-${f}" of grep is not supported here.` }
      }
    } else if (a.startsWith('--')) return { refused: `the option "${a}" of grep is not supported here.` }
    else g.rest.push(a)
  }
  return g
}

/** The text filters a pipe may lead into; they work on the previous command's output and touch nothing else. */
function filter(name: string, args: string[], input: string): Step {
  const lines = input.split('\n')
  if (name === 'head' || name === 'tail') {
    let n = 10
    if (args.length === 1 && /^-\d{1,4}$/.test(args[0]!)) n = Number(args[0]!.slice(1))
    else if (args.length === 2 && args[0] === '-n' && /^\d{1,4}$/.test(args[1]!)) n = Number(args[1])
    else if (args.length) return { refused: `after a pipe, ${name} takes only -n N.` }
    return { text: (name === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n') }
  }
  if (name === 'wc') return args.length === 1 && args[0] === '-l' ? { text: String(input ? lines.length : 0) } : { refused: 'after a pipe, only "wc -l" is supported.' }
  if (name === 'sort') return args.length === 0 ? { text: [...lines].sort((a, b) => a.localeCompare(b)).join('\n') } : args.length === 1 && args[0] === '-r' ? { text: [...lines].sort((a, b) => b.localeCompare(a)).join('\n') } : { refused: 'after a pipe, sort takes only -r.' }
  const g = grepArgs(name, args)
  if ('refused' in g) return g
  if (g.rest.length !== 1) return { refused: `after a pipe, ${name} takes the text to look for and nothing else.` }
  let re: RegExp
  try {
    re = new RegExp(g.regex ? g.rest[0]! : g.rest[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), g.ignoreCase ? 'i' : '')
  } catch (e) {
    return { error: `Bad pattern: ${(e as Error).message}` }
  }
  return { text: lines.filter((l) => l.length <= 4000 && re.test(l) !== g.invert).join('\n') }
}
