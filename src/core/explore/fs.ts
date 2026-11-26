/**
 * Read-only look around the user's PC for the voice agent: list a folder, find by name, read a text file, search
 * text. Nothing here writes, deletes, moves or runs anything.
 *
 * The fence: every path is resolved (`..`, symlinks and junctions included) and must end up inside one of the
 * approved root folders (Settings > PC access). On top of that, files that usually hold secrets (.env, private
 * keys, credential stores) are never opened even inside a root, and key-shaped strings are masked in what is
 * returned: the text goes to a hosted model and may be read aloud.
 *
 * Every operation has caps on results, bytes, folders walked and time, so a reply stays short enough to speak and
 * a search of a whole drive ends by itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

export type Allowed = { ok: true; path: string } | { ok: false; error: string }

export interface ExplorerOptions {
  /** Injectable for tests; resolves symlinks. Must throw for a path that does not exist. */
  realpath?: (p: string) => Promise<string>
  /** Wall-clock budget for one find or grep. */
  budgetMs?: number
  /** Folders one find or grep may open. */
  maxDirs?: number
}

export interface Entry {
  path: string
  type: 'folder' | 'file'
  /** Files only. */
  kb?: number
  modified?: string
}

/** Folders never walked into by find and grep: huge, generated, or the system's own. Listing them by path still works. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'site-packages',
  '.next', '.nuxt', '.gradle', '.cache', 'appdata'
])
/** The system's own folders at the top of a drive; skipped there only (a project may well have a "windows" folder). */
const SYSTEM_DIRS = new Set(['windows', 'programdata', '$recycle.bin', 'system volume information', '$windows.~bt', '$windows.~ws', 'recovery', 'config.msi', 'msocache', 'perflogs'])
/** Folders whose contents are credentials; nothing inside is ever read, searched or listed. */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker', '.password-store'])
const SECRET_FILES = [
  /^\.env(\.(?!example$|sample$|template$|dist$).*)?$/i,
  /\.env$/i,
  /\.(pem|key|pfx|p12|ppk|kdbx|keystore|jks|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^(keys?|credentials?|secrets?|tokens?|passwords?)\.(json|ya?ml|toml|txt|ini|csv|xml)$/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|htpasswd|pgpass)$/i,
  /^prox(y|ies)[\w.-]*\.(txt|csv|json)$/i,
  /^(login data|cookies|wallet\.dat)$/i
]
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'psd', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mkv', 'mov', 'avi', 'webm',
  'zip', '7z', 'rar', 'gz', 'tar', 'bz2', 'xz', 'iso', 'exe', 'dll', 'msi', 'bin', 'dat', 'so', 'dylib', 'pyd', 'pyc', 'class', 'jar', 'wasm', 'node',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'onnx', 'pt', 'pth', 'safetensors', 'gguf', 'ckpt', 'npy', 'npz', 'parquet', 'sqlite', 'db',
  'ttf', 'otf', 'woff', 'woff2', 'eot'
])

/** True for a file name that usually holds secrets; such files are never opened. */
export function isSecretName(name: string): boolean {
  return SECRET_FILES.some((re) => re.test(name))
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key hidden]'],
  [/\b(sk-ant-|sk-proj-|sk-|gsk_|xai-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|hf_|pk_live_|sk_live_|rk_live_)[A-Za-z0-9_\-]{12,}/g, '[key hidden]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, '$1[login hidden]@'],
  [/((?:api[_-]?key|secret|token|passw(?:or)?d|authorization|bearer)["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-./+]{16,})/gi, '$1[hidden]']
]

/** Mask key-shaped strings (API keys, private keys, logins inside URLs) in text that leaves the machine. */
export function redact(text: string): string {
  let out = text
  for (const [re, to] of REDACTIONS) out = out.replace(re, to)
  return out
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const kb = (bytes: number): number => Math.max(bytes ? 0.1 : 0, Math.round(bytes / 102.4) / 10)
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
/** Letters and digits only, lower-case: "Lemon-AI_v2" and "lemon ai v2" compare equal. */
const squash = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** A glob (`*`, `**`, `?`) as a case-insensitive regex; with a slash in it, it matches the path below the search folder. */
export function globToRegex(glob: string): RegExp {
  let re = ''
  const g = glob.replace(/\\/g, '/')
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += '.*'
        i++
        if (g[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/**
 * How a name is matched: a glob when the query has `*` or `?`, otherwise every word of the query must occur in the
 * name, ignoring case, spaces and punctuation ("lemon ai" finds LemonAI, lemon-ai-app, Lemon_AI).
 * Returns a rank (0 = the name is exactly the query, 1 = starts with it, 2 = contains it, 3 = has every word,
 * PARTIAL = has only some of the longer words: speech recognition adds and drops words) or -1 for no match.
 */
export function nameMatcher(query: string): (name: string, rel: string) => number {
  const q = query.trim()
  if (/[*?]/.test(q)) {
    const re = globToRegex(q)
    const onPath = /[\\/]/.test(q)
    return (name, rel) => (re.test(onPath ? rel.replace(/\\/g, '/') : name) ? 1 : -1)
  }
  const whole = squash(q)
  const words = q.split(/[\s\-_,]+/).map(squash).filter(Boolean)
  const long = words.filter((w) => w.length >= 4 && !COMMON_WORDS.has(w))
  if (!whole) return () => -1
  return (name) => {
    const n = squash(name)
    if (!n) return -1
    if (n === whole) return 0
    if (n.startsWith(whole)) return 1
    if (n.includes(whole)) return 2
    if (words.length < 2) return -1
    if (words.every((w) => n.includes(w))) return 3
    return long.some((w) => n.includes(w)) ? PARTIAL : -1
  }
}

/** Rank of a name that has only some of the query's words; offered only when nothing has them all. */
export const PARTIAL = 4
/** Words too common in folder names to stand for a match on their own. */
const COMMON_WORDS = new Set(['project', 'projects', 'folder', 'file', 'files', 'data', 'test', 'tests', 'code', 'main', 'docs', 'document', 'documents', 'backup', 'copy', 'final', 'drive', 'thing', 'stuff', 'that', 'this', 'with', 'from', 'your', 'mine'])
/** find stops this many levels below its first match: nearer matches are nearly always the ones meant. */
const NEAREST_LEVELS = 2

export class PcExplorer {
  private readonly real: (p: string) => Promise<string>
  private readonly budgetMs: number
  private readonly maxDirs: number

  constructor(
    private readonly rootsOf: () => string[],
    opts: ExplorerOptions = {}
  ) {
    this.real = opts.realpath ?? canonical
    this.budgetMs = opts.budgetMs ?? 8000
    this.maxDirs = opts.maxDirs ?? 20000
  }

  /** The approved folders as written in Settings: absolute ones only, duplicates dropped. */
  roots(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of this.rootsOf() ?? []) {
      const r = cleanInput(typeof raw === 'string' ? raw : '')
      if (!r || !path.isAbsolute(r) || isDevicePath(r)) continue
      const abs = path.resolve(r)
      const k = abs.toLowerCase()
      if (!seen.has(k)) {
        seen.add(k)
        out.push(abs)
      }
    }
    return out
  }

  /** Resolve symlinks of the deepest part that exists, keeping the rest as written. */
  private async realOf(p: string): Promise<string> {
    let cur = path.resolve(p)
    const tail: string[] = []
    for (;;) {
      try {
        return path.join(await this.real(cur), ...tail.reverse())
      } catch {
        const parent = path.dirname(cur)
        if (parent === cur) return path.resolve(p)
        tail.push(path.basename(cur))
        cur = parent
      }
    }
  }

  /**
   * The fence. An absolute path must resolve (after `..`, symlinks and junctions) to an approved root or below one;
   * a relative path is looked up under each root in turn. Device and network paths, alternate data streams and
   * credential folders are refused outright.
   */
  async resolve(input: string): Promise<Allowed> {
    const roots = this.roots()
    if (!roots.length) return { ok: false, error: 'No folders are approved yet. The user can add some in Settings > PC access.' }
    const raw = cleanInput(input)
    if (!raw) return { ok: false, error: 'No path given.' }
    if (raw.includes('\0')) return { ok: false, error: 'That is not a valid path.' }
    if (isDevicePath(raw)) return { ok: false, error: 'Network and device paths are not allowed.' }
    if (process.platform === 'win32' && raw.replace(/^[a-z]:/i, '').includes(':')) return { ok: false, error: 'That is not a valid path.' }

    if (raw.split(/[\\/]/).some((seg) => DEVICE_NAMES.test(seg))) return { ok: false, error: 'That is a device name, not a file.' }

    const realRoots = await Promise.all(roots.map((r) => this.realOf(r)))
    const candidates = path.isAbsolute(raw) ? [path.resolve(raw)] : roots.map((r) => path.resolve(r, raw))
    let firstInside: string | null = null
    for (const cand of candidates) {
      const real = await this.realOf(cand)
      if (!realRoots.some((root) => inside(root, real))) continue
      if (real.split(/[\\/]/).some((seg) => SECRET_DIRS.has(seg.toLowerCase()))) return { ok: false, error: 'That folder holds credentials and is never read.' }
      if (candidates.length === 1 || fs.existsSync(real)) return { ok: true, path: real }
      firstInside ??= real
    }
    if (firstInside) return { ok: true, path: firstInside }
    return { ok: false, error: `"${clip(raw, 120)}" is outside the folders you may read (${roots.join(', ')}). The user can approve more in Settings > PC access.` }
  }

  /** What is in a folder: sub-folders and files by name, capped. With no path, the approved folders themselves. */
  async list(input: string | undefined, limit = 60): Promise<Record<string, unknown>> {
    if (!cleanInput(input ?? '')) return { approved_folders: this.roots(), note: this.roots().length ? 'Pass one of these (or a folder inside one) as path.' : 'None yet: the user adds them in Settings > PC access.' }
    const at = await this.resolve(input!)
    if (!at.ok) return { error: at.error }
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(at.path, { withFileTypes: true })
    } catch (e) {
      return { error: fsError(e, at.path) }
    }
    const visible = dirents.filter((d) => !SECRET_DIRS.has(d.name.toLowerCase()))
    const folders = visible.filter((d) => d.isDirectory()).map((d) => d.name).sort(byName)
    const fileNames = visible.filter((d) => !d.isDirectory()).map((d) => d.name).sort(byName)
    const cap = Math.max(1, Math.min(200, Math.round(limit)))
    const shownFolders = folders.slice(0, cap)
    const shownFiles = fileNames.slice(0, Math.max(0, cap - shownFolders.length))
    const files = await Promise.all(
      shownFiles.map(async (name) => {
        try {
          const st = await fs.promises.stat(path.join(at.path, name))
          return `${name} (${kb(st.size)} KB, ${day(st.mtimeMs)})`
        } catch {
          return name
        }
      })
    )
    const hidden = folders.length + fileNames.length - shownFolders.length - shownFiles.length
    return { path: at.path, folders: shownFolders, files, total_folders: folders.length, total_files: fileNames.length, ...(hidden > 0 ? { not_shown: hidden } : {}) }
  }

  /**
   * Breadth-first walk below `base`, a few folders at a time. Symlinks and junctions are not followed, so the walk
   * cannot leave the root or loop. Stops at the time budget, the folder cap, or when `visit` returns false.
   */
  private async walk(
    base: string,
    signal: AbortSignal | undefined,
    visit: (dir: string, entries: fs.Dirent[], level: number) => boolean | Promise<boolean>,
    deadline = Date.now() + this.budgetMs
  ): Promise<{ dirs: number; end: 'done' | 'limit' | 'stopped' }> {
    let queue = [base]
    let dirs = 0
    for (let level = 0; queue.length; level++) {
      const next: string[] = []
      for (let i = 0; i < queue.length; i += 8) {
        if (signal?.aborted || Date.now() > deadline || dirs >= this.maxDirs) return { dirs, end: 'limit' }
        const batch = queue.slice(i, i + 8)
        const read = await Promise.all(batch.map((d) => fs.promises.readdir(d, { withFileTypes: true }).catch(() => [] as fs.Dirent[])))
        for (let j = 0; j < batch.length; j++) {
          dirs++
          const entries = read[j]!
          const top = path.parse(batch[j]!).root === batch[j]
          if (!(await visit(batch[j]!, entries, level))) return { dirs, end: 'stopped' }
          for (const e of entries) {
            if (!e.isDirectory()) continue
            const low = e.name.toLowerCase()
            if (SKIP_DIRS.has(low) || SECRET_DIRS.has(low) || (top && SYSTEM_DIRS.has(low))) continue
            next.push(path.join(batch[j]!, e.name))
          }
        }
      }
      queue = next
    }
    return { dirs, end: 'done' }
  }

  /**
   * Files and folders whose name matches, nearest to the top first. `path` empty = every approved folder.
   * A whole drive is too big to walk in the time a spoken reply has, so the search goes level by level and stops
   * two levels below the first match (the nearest ones are nearly always the ones meant), saying so. When no name
   * has every word of the query, names that have some of the words are offered instead.
   */
  async find(query: string, opts: { path?: string; type?: 'any' | 'folder' | 'file'; limit?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (!query?.trim()) return { error: 'Nothing to look for.' }
    const bases = await this.bases(opts.path)
    if ('error' in bases) return bases
    const match = nameMatcher(query)
    const limit = Math.max(1, Math.min(50, Math.round(opts.limit ?? 15)))
    const type = opts.type ?? 'any'
    type Hit = { full: string; dir: boolean; rank: number; depth: number }
    const hits: Hit[] = []
    const partial: Hit[] = []
    const deadline = Date.now() + this.budgetMs
    let dirs = 0
    let end: 'done' | 'limit' | 'stopped' = 'done'
    for (const base of bases.paths) {
      let firstHitLevel = -1
      let firstPartialLevel = -1
      const r = await this.walk(
        base,
        opts.signal,
        (dir, entries, level) => {
          if (firstHitLevel >= 0 ? level > firstHitLevel + NEAREST_LEVELS : firstPartialLevel >= 0 && level > firstPartialLevel + NEAREST_LEVELS + 1) return false
          for (const e of entries) {
            const isDir = e.isDirectory()
            if ((type === 'folder' && !isDir) || (type === 'file' && isDir)) continue
            const full = path.join(dir, e.name)
            const rel = path.relative(base, full)
            const rank = match(e.name, rel)
            if (rank < 0) continue
            if (rank === PARTIAL) {
              if (firstPartialLevel < 0) firstPartialLevel = level
              if (partial.length < 200) partial.push({ full, dir: isDir, rank, depth: level })
              continue
            }
            if (firstHitLevel < 0) firstHitLevel = level
            hits.push({ full, dir: isDir, rank, depth: level })
          }
          return hits.length < 400
        },
        deadline
      )
      dirs += r.dirs
      if (r.end !== 'done' && end !== 'limit') end = r.end
    }
    const loose = hits.length === 0 && partial.length > 0
    const pool = loose ? partial : hits
    pool.sort((a, b) => a.rank - b.rank || a.depth - b.depth || Number(b.dir) - Number(a.dir) || a.full.localeCompare(b.full))
    const matches: Entry[] = await Promise.all(
      pool.slice(0, limit).map(async (h): Promise<Entry> => {
        if (h.dir) return { path: h.full, type: 'folder' }
        try {
          const st = await fs.promises.stat(h.full)
          return { path: h.full, type: 'file', kb: kb(st.size), modified: day(st.mtimeMs) }
        } catch {
          return { path: h.full, type: 'file' }
        }
      })
    )
    return {
      matches,
      ...(pool.length > limit ? { more_matches: pool.length - limit } : {}),
      ...(loose ? { note: 'No name has all of those words; these have some of them.' } : {}),
      folders_searched: dirs,
      ...(end === 'limit'
        ? { incomplete: 'Stopped early (time or size limit): pass a narrower path to search deeper.' }
        : end === 'stopped'
          ? { incomplete: 'These are the nearest matches; deeper folders were not searched. Pass a path to look further down.' }
          : {})
    }
  }

  /** A text file's contents from a line on, capped; refuses binaries and files that usually hold secrets. */
  async read(input: string, opts: { fromLine?: number; maxChars?: number } = {}): Promise<Record<string, unknown>> {
    const at = await this.resolve(input)
    if (!at.ok) return { error: at.error }
    if (isSecretName(path.basename(at.path))) return { error: `${path.basename(at.path)} usually holds passwords or keys, so it is never read. The user can open it themselves.` }
    let fh: fs.promises.FileHandle
    let st: fs.Stats
    try {
      st = await fs.promises.stat(at.path)
      if (st.isDirectory()) return { error: 'That is a folder: list it instead.' }
      if (!st.isFile()) return { error: 'That is not an ordinary file.' }
      fh = await fs.promises.open(at.path, 'r')
    } catch (e) {
      return { error: fsError(e, at.path) }
    }
    try {
      const maxBytes = 1024 * 1024
      const buf = Buffer.alloc(Math.min(st.size, maxBytes))
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const data = buf.subarray(0, bytesRead)
      if (BINARY_EXT.has(ext(at.path)) || looksBinary(data)) return { error: `Not a text file (${ext(at.path) || 'binary'}, ${kb(st.size)} KB).`, path: at.path }
      const lines = data.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
      const from = Math.max(1, Math.round(opts.fromLine ?? 1))
      const maxChars = Math.max(200, Math.min(12000, Math.round(opts.maxChars ?? 6000)))
      let text = ''
      let to = from - 1
      for (let i = from - 1; i < lines.length; i++) {
        const line = clip(lines[i]!, 2000)
        if (text.length + line.length + 1 > maxChars && text) break
        text += (text ? '\n' : '') + line
        to = i + 1
        if (text.length >= maxChars) break
      }
      const cutByBytes = st.size > maxBytes
      const more = to < lines.length || cutByBytes
      return {
        path: at.path,
        kb: kb(st.size),
        lines: `${from}-${to} of ${cutByBytes ? 'more than ' : ''}${lines.length}`,
        text: redact(clip(text, maxChars)),
        ...(more ? { more: to < lines.length ? `Call again with from_line ${to + 1} for the next part.` : 'Only the first megabyte can be read.' } : {})
      }
    } catch (e) {
      return { error: fsError(e, at.path) }
    } finally {
      await fh.close().catch(() => undefined)
    }
  }

  /** Lines containing `text` in the text files below a folder (or in one file), capped per file and overall. */
  async grep(text: string, opts: { path?: string; files?: string; regex?: boolean; caseSensitive?: boolean; limit?: number; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (!text) return { error: 'Nothing to search for.' }
    let re: RegExp
    try {
      re = new RegExp(opts.regex ? text : text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? '' : 'i')
    } catch (e) {
      return { error: `Bad pattern: ${(e as Error).message}` }
    }
    const bases = await this.bases(opts.path, true)
    if ('error' in bases) return bases
    const limit = Math.max(1, Math.min(50, Math.round(opts.limit ?? 20)))
    const nameOk = opts.files?.trim() ? globToRegex(opts.files.trim().replace(/^.*[\\/]/, '')) : null
    const matches: Array<{ file: string; line: number; text: string }> = []
    const deadline = Date.now() + this.budgetMs
    let scanned = 0
    let filesHit = 0
    let complete = true
    const scan = async (file: string): Promise<void> => {
      const name = path.basename(file)
      if (isSecretName(name) || BINARY_EXT.has(ext(file)) || (nameOk && !nameOk.test(name))) return
      let data: Buffer
      try {
        const st = await fs.promises.stat(file)
        if (!st.isFile() || st.size > 1024 * 1024 || st.size === 0) return
        data = await fs.promises.readFile(file)
      } catch {
        return
      }
      if (looksBinary(data)) return
      scanned++
      let inFile = 0
      const lines = data.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length && inFile < 5 && matches.length < limit; i++) {
        const line = lines[i]!
        if (line.length > 4000 || !re.test(line)) continue
        if (!inFile++) filesHit++
        matches.push({ file, line: i + 1, text: redact(clip(line.trim(), 200)) })
      }
    }
    let dirs = 0
    for (const base of bases.paths) {
      if (bases.file) {
        await scan(base)
        continue
      }
      const r = await this.walk(base, opts.signal, async (dir, entries) => {
        for (const e of entries) {
          if (!e.isFile()) continue
          if (matches.length >= limit || scanned >= 4000 || Date.now() > deadline || opts.signal?.aborted) return false
          await scan(path.join(dir, e.name))
        }
        return matches.length < limit
      })
      dirs += r.dirs
      complete &&= r.end === 'done'
      if (matches.length >= limit) break
    }
    return {
      matches,
      files_with_matches: filesHit,
      files_searched: scanned,
      ...(matches.length >= limit ? { note: `Stopped at ${limit} matching lines; there may be more.` } : complete ? {} : { incomplete: 'Stopped early (time or size limit): pass a narrower path or a files filter.' })
    }
  }

  /** Where a find or grep starts: the given folder (or file, for grep), or every approved root. */
  private async bases(input: string | undefined, fileOk = false): Promise<{ paths: string[]; file?: boolean } | { error: string }> {
    if (!cleanInput(input ?? '')) {
      const roots = this.roots()
      if (!roots.length) return { error: 'No folders are approved yet. The user can add some in Settings > PC access.' }
      const real = await Promise.all(roots.map((r) => this.realOf(r)))
      return { paths: real.filter((r) => fs.existsSync(r)) }
    }
    const at = await this.resolve(input!)
    if (!at.ok) return { error: at.error }
    try {
      const st = await fs.promises.stat(at.path)
      if (st.isDirectory()) return { paths: [at.path] }
      return fileOk ? { paths: [at.path], file: true } : { error: 'That is a file, not a folder.' }
    } catch (e) {
      return { error: fsError(e, at.path) }
    }
  }
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
const ext = (p: string): string => path.extname(p).slice(1).toLowerCase()
const looksBinary = (buf: Buffer): boolean => buf.subarray(0, 4096).includes(0)
const isDevicePath = (p: string): boolean => /^[\\/]{2}/.test(p)
/** Windows device names: opening "CON" or "NUL" in any folder reaches the device, not a file. */
const DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(\..*)?$/i

const nativeRealpath = promisify(fs.realpath.native)
/**
 * The path as the system itself names it: links followed, 8.3 short names expanded ("KEYS~1.JSO" is keys.json),
 * trailing dots dropped, real upper and lower case. The secrets check runs on this name, never on the one typed.
 */
async function canonical(p: string): Promise<string> {
  try {
    return await nativeRealpath(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw e
    return fs.promises.realpath(p) // drives the native call cannot resolve (some substituted or RAM drives)
  }
}

/** Trim, drop wrapping quotes, and read a bare drive ("D:") as its root rather than the process's current folder on it. */
function cleanInput(input: string): string {
  let s = (input ?? '').trim().replace(/^["'`]+|["'`]+$/g, '').trim()
  if (process.platform === 'win32') {
    const msys = /^\/([a-z])(\/.*)?$/i.exec(s) // Git Bash style: /d/Projects
    if (msys) s = `${msys[1]!.toUpperCase()}:${(msys[2] ?? '/').replace(/\//g, '\\')}`
    // Windows ignores dots and spaces at the end of a name, so "keys.json." would open keys.json
    if (!/(^|[\\/])\.{1,2}$/.test(s)) s = s.replace(/[. ]+$/, '')
    if (/^[a-z]:$/i.test(s)) s += '\\'
    else if (/^[a-z]:[^\\/]/i.test(s)) s = `${s.slice(0, 2)}\\${s.slice(2)}` // "D:foo" is drive-relative; read it as D:\foo
  }
  return s
}

/** `target` is `root` or below it. Both must already be resolved; Windows compares without case. */
function inside(root: string, target: string): boolean {
  const [r, t] = process.platform === 'win32' ? [root.toLowerCase(), target.toLowerCase()] : [root, target]
  const rel = path.relative(r, t)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function fsError(e: unknown, p: string): string {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return `Nothing exists at ${p}.`
  if (code === 'EACCES' || code === 'EPERM') return `Windows denies access to ${p}.`
  if (code === 'ENOTDIR') return `${p} is a file, not a folder.`
  return `Could not open ${p} (${code ?? (e as Error)?.message ?? 'unknown error'}).`
}

/** True when a file is not text by its extension or its first bytes. */
export function isBinary(p: string, data: Buffer): boolean {
  return BINARY_EXT.has(ext(p)) || looksBinary(data)
}
