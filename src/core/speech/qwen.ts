import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { QWEN_DEFAULT_HOST, TTS_PROVIDERS } from '@shared/tts'
import type { TtsCatalog } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { isAbort, type TtsEngine, type TtsRequest } from './tts'

/**
 * Qwen-Audio TTS on Alibaba Model Studio (DashScope) over its WebSocket protocol: one `run-task` per sentence,
 * audio back as binary frames, `task-finished` to close the round. Opening a socket costs about a second, so a
 * small pool of sockets stays open between sentences and turns, like the Edge pool.
 */
export interface QwenDeps {
  key: () => string
  /** Workspace host (`ws-….ap-southeast-1.maas.aliyuncs.com`) or the public one; from DASHSCOPE_HOST. */
  host: () => string
  /** Proxy agent for the socket, when the user routes hosted voices through one. */
  agent?: () => unknown
  poolSize?: number
  timeoutMs?: () => number
  log?: (msg: string) => void
  /** Test seam. */
  WebSocket?: typeof WebSocket
}

const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' })

type Msg = { header?: { event?: string; task_id?: string; error_code?: string; error_message?: string } }

class Socket {
  ws: WebSocket | null = null
  busy = false
  constructor(readonly key: string) {}

  async open(url: string, token: string, agent: unknown, WS: typeof WebSocket): Promise<void> {
    if (this.ws && this.ws.readyState === WS.OPEN) return
    this.dispose()
    const ws = new WS(url, { headers: { Authorization: `bearer ${token}` }, agent: agent as never })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (e) => reject(e))
      ws.once('unexpected-response', (_req, res) => {
        let body = ''
        res.on('data', (d: Buffer) => (body += d.toString()))
        res.on('end', () => reject(new Error(`Qwen HTTP ${res.statusCode}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`)))
      })
    })
    this.ws = ws
  }

  dispose(): void {
    try {
      this.ws?.close()
    } catch {
      // already closed
    }
    this.ws = null
  }
}

export class QwenEngine implements TtsEngine {
  readonly name = 'qwen' as const
  private readonly info = TTS_PROVIDERS.qwen
  private sockets: Socket[] = []
  private waiters: Array<() => void> = []

  constructor(private readonly deps: QwenDeps) {}

  acceptsTags(): boolean {
    return false
  }

  private get timeout(): number {
    return this.deps.timeoutMs?.() ?? DEFAULT_TUNING.speech.ttsTimeoutMs
  }

  private url(): string {
    const host = (this.deps.host() || QWEN_DEFAULT_HOST).replace(/^wss?:\/\//, '').replace(/\/.*$/, '')
    return `wss://${host}/api-ws/v1/inference`
  }

  private async acquire(): Promise<Socket> {
    for (;;) {
      const free = this.sockets.find((s) => !s.busy)
      if (free) {
        free.busy = true
        return free
      }
      if (this.sockets.length < (this.deps.poolSize ?? DEFAULT_TUNING.speech.ttsPoolSize)) {
        const s = new Socket(this.url())
        s.busy = true
        this.sockets.push(s)
        return s
      }
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }

  private release(s: Socket, healthy: boolean): void {
    if (!healthy) {
      s.dispose()
      this.sockets = this.sockets.filter((x) => x !== s)
    } else s.busy = false
    this.waiters.shift()?.()
  }

  /** Drop every socket (the host or proxy setting changed). */
  reset(): void {
    for (const s of this.sockets) s.dispose()
    this.sockets = []
  }

  async synth(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) throw abortError()
    const key = this.deps.key().trim()
    if (!key) throw new Error('no API key for Qwen')
    const s = await this.acquire()
    let healthy = true
    const t0 = performance.now()
    try {
      if (s.key !== this.url()) s.dispose()
      await s.open(this.url(), key, this.deps.agent?.(), this.deps.WebSocket ?? WebSocket)
      const ws = s.ws!
      const taskId = randomUUID()
      const send = (action: string, payload: Record<string, unknown>): void => ws.send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }))
      return await new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = []
        let settled = false
        const finish = (err: Error | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          ws.off('message', onMessage)
          ws.off('close', onClose)
          ws.off('error', onError)
          if (err) {
            healthy = false
            reject(err)
          } else if (!parts.length) {
            healthy = false
            reject(new Error('Qwen returned no audio'))
          } else resolve(Buffer.concat(parts))
        }
        const onAbort = (): void => finish(abortError())
        const onClose = (): void => finish(new Error('Qwen connection closed'))
        const onError = (e: Error): void => finish(new Error(`Qwen websocket error: ${e.message}`))
        const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
          if (isBinary) {
            if (!parts.length) req.onFirstByte?.(performance.now() - t0)
            parts.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
            return
          }
          let msg: Msg
          try {
            msg = JSON.parse(data.toString()) as Msg
          } catch {
            return
          }
          if (msg.header?.task_id && msg.header.task_id !== taskId) return
          switch (msg.header?.event) {
            case 'task-started':
              send('continue-task', { input: { text: req.text } })
              send('finish-task', { input: {} })
              break
            case 'task-finished':
              finish(null)
              break
            case 'task-failed':
              finish(new Error(`Qwen ${msg.header.error_code ?? 'error'}: ${(msg.header.error_message ?? '').slice(0, 160)}`))
              break
            default:
              break
          }
        }
        const timer = setTimeout(() => finish(new Error('Qwen timed out')), this.timeout)
        signal.addEventListener('abort', onAbort, { once: true })
        ws.on('message', onMessage)
        ws.on('close', onClose)
        ws.on('error', onError)
        const parameters: Record<string, unknown> = {
          text_type: 'PlainText',
          voice: req.voice || this.info.defaultVoice,
          format: 'mp3',
          sample_rate: 24000,
          rate: Math.min(2, Math.max(0.5, 1 + req.rate)),
          volume: 50,
          pitch: Math.min(2, Math.max(0.5, 1 + req.pitch / 100))
        }
        if (req.instruction) parameters.instruction = req.instruction
        send('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: req.model || this.info.defaultModel, parameters, input: {} })
      })
    } catch (e) {
      // an abort leaves the socket in the middle of a task; cheaper to drop it than to drain it
      healthy = false
      if (isAbort(e) || signal.aborted) throw abortError()
      throw e
    } finally {
      this.release(s, healthy)
    }
  }

  /** Model Studio has no listing call for voices: the built-in presets plus whatever the user typed. */
  async catalog(): Promise<TtsCatalog> {
    return { provider: 'qwen', voices: this.info.voices, models: this.info.models }
  }
}
