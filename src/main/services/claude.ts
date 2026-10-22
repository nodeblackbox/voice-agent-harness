import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CcSession } from '@shared/claude'
import type { Settings } from '@shared/types'
import { ClaudeSessionManager } from '@core/claude/manager'
import { realSdk } from '@core/claude/sdk'
import { log, logError } from './log'

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

  constructor(userData: string, private settings: () => Settings) {
    this.file = join(userData, 'claude-sessions.json')
    const s = () => this.settings().claude
    this.manager = new ClaudeSessionManager({
      sdk: realSdk,
      workspaceRoot: s().workspaceRoot,
      config: () => ({ workspaceRoot: s().workspaceRoot, model: s().model, maxSessions: s().maxSessions, approveShell: s().approveShell }),
      persist: (sessions) => this.scheduleSave(sessions)
    })
    this.load()
  }

  enabled(): boolean {
    return this.settings().claude.enabled
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
