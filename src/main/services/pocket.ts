// The Pocket TTS server. When the owner picks Pocket TTS, this either starts `pocket-tts serve` on a free local port
// (the command from Settings, else POCKET_TTS_COMMAND, else `pocket-tts` on the PATH) or, when the setting is an
// http(s) address, uses a server the owner runs themselves. The first start can take a while: the model is
// downloaded once into the Hugging Face cache. Edge speaks until the health check answers.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import type { PocketBackend } from '@core/speech/pocket'
import { log, logAt } from './log'

export interface PocketOptions {
  /** A path to the pocket-tts executable (or a command line such as "uvx pocket-tts"), or an http(s) server address. */
  server: () => string
  voice: () => string
  env?: NodeJS.ProcessEnv
  spawn?: typeof spawn
  fetch?: typeof fetch
}

const LOAD_TIMEOUT_MS = 180_000
const RETRY_AFTER_MS = 5 * 60_000

export type PocketState = { state: 'off' } | { state: 'loading'; since: number } | { state: 'ready'; url: string } | { state: 'failed'; error: string }

/** "C:\\a b\\pocket-tts.exe" stays one piece; "uvx pocket-tts" splits into a command and its arguments. */
export function commandLine(raw: string): string[] {
  const s = raw.trim()
  if (!s) return []
  if (existsSync(s)) return [s]
  const parts = s.match(/"[^"]+"|\S+/g) ?? []
  return parts.map((p) => p.replace(/^"|"$/g, ''))
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export class PocketService implements PocketBackend {
  private proc: ChildProcess | null = null
  private url: string | null = null
  private starting: Promise<boolean> | null = null
  private failedAt = 0
  private lastError = ''
  private loadingSince = 0
  private readonly listeners = new Set<(s: PocketState) => void>()

  constructor(private readonly opts: PocketOptions) {}

  ready(): boolean {
    return this.url !== null
  }

  state(): PocketState {
    if (this.url !== null) return { state: 'ready', url: this.url }
    if (this.starting) return { state: 'loading', since: this.loadingSince }
    if (this.failedAt) return { state: 'failed', error: this.lastError }
    return { state: 'off' }
  }

  onState(cb: (s: PocketState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    const s = this.state()
    for (const cb of this.listeners) cb(s)
  }

  start(opts: { force?: boolean } = {}): Promise<boolean> {
    if (this.url !== null) return Promise.resolve(true)
    if (this.starting) return this.starting
    if (!opts.force && Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve(false)
    this.loadingSince = Date.now()
    this.starting = this.launch()
      .then(
        (url) => {
          this.url = url
          this.failedAt = 0
          log('pocket', `ready at ${url}`)
          return true
        },
        (e: Error) => {
          this.failedAt = Date.now()
          this.lastError = e.message
          logAt('warn', 'pocket', `not available: ${e.message}`)
          this.stopProcess()
          return false
        }
      )
      .finally(() => {
        this.starting = null
        this.changed()
      })
    this.changed()
    return this.starting
  }

  private async healthy(url: string): Promise<boolean> {
    try {
      const r = await (this.opts.fetch ?? fetch)(`${url}/health`, { signal: AbortSignal.timeout(3000) })
      return r.ok
    } catch {
      return false
    }
  }

  private async waitHealthy(url: string, exited: () => string | null): Promise<void> {
    const until = Date.now() + LOAD_TIMEOUT_MS
    while (Date.now() < until) {
      const gone = exited()
      if (gone) throw new Error(gone)
      if (await this.healthy(url)) return
      await new Promise((r) => setTimeout(r, 1000))
    }
    throw new Error(`did not answer within ${LOAD_TIMEOUT_MS / 1000} s`)
  }

  private async launch(): Promise<string> {
    const configured = this.opts.server().trim()
    // a server the owner runs: only check that it answers
    if (/^https?:\/\//i.test(configured)) {
      const url = configured.replace(/\/+$/, '')
      if (!(await this.healthy(url))) throw new Error(`nothing answers at ${url}/health`)
      return url
    }
    const env = this.opts.env ?? process.env
    const cmd = commandLine(configured || env.POCKET_TTS_COMMAND || 'pocket-tts')
    if (!cmd.length) throw new Error('no pocket-tts command set')
    const port = await freePort()
    const args = [...cmd.slice(1), 'serve', '--host', '127.0.0.1', '--port', String(port), '--default-voice', this.opts.voice()]
    log('pocket', `starting ${cmd[0]} ${args.join(' ')}`)
    let exitReason: string | null = null
    let errText = ''
    const proc = (this.opts.spawn ?? spawn)(cmd[0]!, args, { env: { ...env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    const keep = (d: Buffer): void => {
      for (const line of d.toString().split(/\r?\n/)) {
        if (!line.trim()) continue
        errText = line.trim()
        if (!/GET \/health/.test(line)) log('pocket', line.trim().slice(0, 300))
      }
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    proc.on('error', (e) => (exitReason = /ENOENT/.test(e.message) ? `"${cmd[0]}" was not found: install pocket-tts or set its path in Settings > Voice output` : e.message))
    proc.on('exit', (code) => {
      exitReason ??= `exited with code ${code}${errText ? `: ${errText.slice(0, 200)}` : ''}`
      const wasReady = this.proc === proc && this.url !== null
      if (this.proc === proc) {
        this.proc = null
        this.url = null
      }
      if (wasReady) {
        logAt('warn', 'pocket', `server stopped: ${exitReason}`)
        this.changed()
      }
    })
    const url = `http://127.0.0.1:${port}`
    await this.waitHealthy(url, () => exitReason)
    return url
  }

  async synth(text: string, voice: string, signal: AbortSignal): Promise<Buffer> {
    if (this.url === null) throw new Error('Pocket TTS is not running')
    const form = new FormData()
    form.set('text', text)
    if (voice) form.set('voice_url', voice)
    const res = await (this.opts.fetch ?? fetch)(`${this.url}/tts`, { method: 'POST', body: form, signal })
    if (!res.ok) throw new Error(`Pocket TTS ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return Buffer.from(await res.arrayBuffer())
  }

  private stopProcess(): void {
    const proc = this.proc
    this.proc = null
    if (!proc) return
    // on Windows pocket-tts.exe is a launcher with the Python server as its child: end the whole tree
    if (process.platform === 'win32' && proc.pid) {
      try {
        ;(this.opts.spawn ?? spawn)('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        return
      } catch {
        // fall through to a plain kill
      }
    }
    proc.kill()
  }

  stop(): void {
    const was = this.url !== null
    this.stopProcess()
    this.url = null
    if (was) this.changed()
  }
}
