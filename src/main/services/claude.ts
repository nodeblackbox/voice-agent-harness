import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserWindow, dialog, net, shell } from 'electron'
import type { CcAccount, CcResult, CcSession } from '@shared/claude'
import type { Settings } from '@shared/types'
import { resolveInside } from '@core/claude/files'
import { ClaudeSessionManager } from '@core/claude/manager'
import { realAccount, realHistory, realSdk } from '@core/claude/sdk'
import { log, logError } from './log'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
}

/**
 * Owns the Claude Code session manager: wires the real SDK and live settings, restores the session
 * registry on launch (nothing runs until the next send, which resumes by SDK session id), saves it on
 * change, and stops every session on quit. Pattern: McpService.
 */
export class ClaudeService {
  readonly manager: ClaudeSessionManager
  private readonly file: string
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private latest: CcSession[] = []
  private who: Promise<CcAccount> | null = null

  constructor(userData: string, private settings: () => Settings) {
    this.file = join(userData, 'claude-sessions.json')
    const s = () => this.settings().claude
    this.manager = new ClaudeSessionManager({
      sdk: realSdk,
      history: realHistory,
      workspaceRoot: s().workspaceRoot,
      config: () => ({ workspaceRoot: s().workspaceRoot, model: s().model, maxSessions: s().maxSessions, defaultMode: s().defaultMode }),
      persist: (sessions) => this.scheduleSave(sessions)
    })
    this.load()
  }

  enabled(): boolean {
    return this.settings().claude.enabled
  }

  /** Absolute path of a file in a session's workspace ('' = the workspace itself), fenced. */
  private pathOf(id: string, rel: string): string | null {
    const s = this.manager.get(id)
    if (!s) return null
    return rel ? resolveInside(s.workspace, rel) : s.workspace
  }

  /** Who sessions run as. Cached: it starts a CLI process (no prompt, so no usage) and takes a few seconds. */
  account(fresh = false): Promise<CcAccount> {
    if (!this.who || fresh) {
      const root = this.settings().claude.workspaceRoot
      mkdirSync(root, { recursive: true })
      this.who = realAccount(root).then((a) => {
        log('claude', `account: ${a.billing}${a.plan ? ` (${a.plan})` : ''}${a.keySource ? ` key=${a.keySource}` : ''}${a.error ? ` error=${a.error}` : ''}`)
        if (a.error) this.who = null
        return a
      })
    }
    return this.who
  }

  /** Native folder picker for "work in this folder", starting in the workspace root. */
  async pickFolder(): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { title: 'Choose the folder this session works in', defaultPath: this.settings().claude.workspaceRoot, properties: ['openDirectory' as const, 'createDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  }

  async open(id: string, rel: string, how: 'default' | 'reveal' | 'code'): Promise<CcResult> {
    const p = this.pathOf(id, rel)
    if (!p || !existsSync(p)) return { ok: false, error: 'Not found in the workspace.' }
    if (how === 'reveal') {
      shell.showItemInFolder(p)
      return { ok: true }
    }
    if (how === 'code') {
      if (p.includes('"')) return { ok: false, error: 'Unsupported path.' }
      return new Promise((done) => {
        const child = spawn(`code "${p}"`, { shell: true, detached: true, stdio: 'ignore', windowsHide: true })
        child.on('error', (e) => done({ ok: false, error: `Could not start VS Code: ${e.message}` }))
        child.on('spawn', () => { child.unref(); done({ ok: true }) })
      })
    }
    const err = await shell.openPath(p)
    return err ? { ok: false, error: err } : { ok: true }
  }

  /**
   * `ccws://<session id>/<path>` serves a session's workspace to the renderer, so the live preview can
   * load the page's own CSS, scripts and images. Read-only and fenced to that one workspace.
   */
  async serve(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html'
    const p = this.pathOf(url.hostname, rel)
    if (!p || !existsSync(p) || !statSync(p).isFile()) return new Response('Not found', { status: 404 })
    const res = await net.fetch(pathToFileURL(p).toString())
    const headers = new Headers(res.headers)
    headers.set('Content-Type', MIME[extname(p).toLowerCase()] ?? res.headers.get('Content-Type') ?? 'application/octet-stream')
    headers.set('Cache-Control', 'no-store')
    headers.set('Access-Control-Allow-Origin', '*')
    return new Response(res.body, { status: 200, headers })
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const list = JSON.parse(readFileSync(this.file, 'utf8')) as CcSession[]
      if (Array.isArray(list)) this.manager.restore(list.filter((x) => x && typeof x.id === 'string' && typeof x.workspace === 'string'))
      log('claude', `restored ${this.manager.list().length} session(s)`)
    } catch (e) {
      logError('claude', 'could not read claude-sessions.json', e)
    }
  }

  private scheduleSave(sessions: CcSession[]): void {
    this.latest = sessions
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 400)
    this.saveTimer.unref?.()
  }

  private flush(): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.latest.map((s) => ({ ...s, pending: undefined })), null, 2))
    } catch (e) {
      logError('claude', 'could not save claude-sessions.json', e)
    }
  }

  async stop(): Promise<void> {
    await this.manager.stopAll()
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    this.latest = this.manager.list()
    this.flush()
  }
}
