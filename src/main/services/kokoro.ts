import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { KokoroBackend } from '@core/speech/tts'
import { log, logAt } from './log'

export interface KokoroOptions {
  projectRoot: string
  python: () => string
  voice: () => string
  /** Test seam. */
  spawn?: typeof spawn
}

const LOAD_TIMEOUT_MS = 120_000
/** After a failed load, don't try again for this long (a broken venv shouldn't respawn every sentence). */
const RETRY_AFTER_MS = 5 * 60_000

export type KokoroState = { state: 'off' } | { state: 'loading'; since: number } | { state: 'ready' } | { state: 'failed'; error: string }

// Kokoro-82M in a Python child (`sidecar/mouth`). Started when it is picked as the voice, or on demand
// as the contingency when a remote voice is down. Loading takes 30-60 s (model onto the GPU).
export class KokoroService implements KokoroBackend {
  private proc: ChildProcess | null = null
  private port: number | null = null
  private starting: Promise<boolean> | null = null
  private failedAt = 0
  private lastError = ''
  private loadingSince = 0
  private readonly listeners = new Set<(s: KokoroState) => void>()

  constructor(private readonly opts: KokoroOptions) {}

  ready(): boolean {
    return this.port !== null
  }

  state(): KokoroState {
    if (this.port !== null) return { state: 'ready' }
    if (this.starting) return { state: 'loading', since: this.loadingSince }
    if (this.failedAt) return { state: 'failed', error: this.lastError }
    return { state: 'off' }
  }

  /** Called on every state change (loading, ready, failed, off). */
  onState(cb: (s: KokoroState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    const s = this.state()
    for (const cb of this.listeners) cb(s)
  }

  /** `force`: the user asked for it, so skip the back-off after a failed load. */
  start(opts: { force?: boolean } = {}): Promise<boolean> {
    if (this.port !== null) return Promise.resolve(true)
    if (this.starting) return this.starting
    if (!opts.force && Date.now() - this.failedAt < RETRY_AFTER_MS) return Promise.resolve(false)
    this.loadingSince = Date.now()
    this.starting = this.launch().finally(() => {
      this.starting = null
      this.changed()
    })
    this.changed()
    return this.starting
  }

  private launch(): Promise<boolean> {
    const python = this.opts.python()
    const args = ['-m', 'mouth', '--port', '0', '--voice', this.opts.voice()]
    log('kokoro', `spawning ${python} ${args.join(' ')}`)
    return new Promise((resolve) => {
      let settled = false
      const done = (ok: boolean, why?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (ok) this.failedAt = 0
        else {
          this.failedAt = Date.now()
          this.lastError = why ?? 'failed to load'
          logAt('warn', 'kokoro', `not available: ${why}`)
          this.stop()
        }
        resolve(ok)
      }
      const timer = setTimeout(() => done(false, `did not load within ${LOAD_TIMEOUT_MS / 1000}s`), LOAD_TIMEOUT_MS)
      let proc: ChildProcess
      try {
        proc = (this.opts.spawn ?? spawn)(python, args, {
          cwd: join(this.opts.projectRoot, 'sidecar'),
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (e) {
        done(false, (e as Error).message)
        return
      }
      this.proc = proc
      let out = ''
      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
        const m = /MOUTH_PORT (\d+)/.exec(out)
        if (m && this.port === null) {
          this.port = Number(m[1])
          log('kokoro', `ready on ${this.port}`)
          done(true)
        }
      })
      proc.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString().split(/\r?\n/)) if (line.trim() && !/warn/i.test(line)) log('kokoro', line.trim())
      })
      proc.on('error', (e) => done(false, e.message))
      proc.on('exit', (code) => {
        log('kokoro', `exited code=${code}`)
        const wasReady = this.proc === proc && this.port !== null
        if (this.proc === proc) {
          this.proc = null
          this.port = null
        }
        done(false, `exited with code ${code} while loading`)
        if (wasReady) this.changed()
      })
    })
  }

  async synth(text: string, voice: string, speed: number, signal: AbortSignal): Promise<Buffer> {
    if (this.port === null) throw new Error('Kokoro is not running')
    const res = await fetch(`http://127.0.0.1:${this.port}/synth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
      signal
    })
    if (!res.ok) throw new Error(`Kokoro ${res.status}: ${await res.text()}`)
    return Buffer.from(await res.arrayBuffer())
  }

  stop(): void {
    const was = this.port !== null
    // closing stdin is the child's cue to exit; kill covers a wedged process
    this.proc?.stdin?.end()
    this.proc?.kill()
    this.proc = null
    this.port = null
    if (was) this.changed()
  }
}
