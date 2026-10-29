import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { QwenEngine } from './qwen'

/** A scripted DashScope socket: answers run-task with task-started, continue/finish with audio frames and task-finished. */
class FakeSocket extends EventEmitter {
  static instances: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  sent: Array<Record<string, unknown>> = []
  closed = false
  constructor(
    readonly url: string,
    readonly opts: { headers: Record<string, string>; agent?: unknown }
  ) {
    super()
    FakeSocket.instances.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.emit('open')
    }, 0)
  }
  send(data: string): void {
    const msg = JSON.parse(data) as { header: { action: string; task_id: string }; payload: { input?: { text?: string } } }
    this.sent.push(msg)
    const reply = (event: string, extra: Record<string, unknown> = {}) => setTimeout(() => this.emit('message', Buffer.from(JSON.stringify({ header: { event, task_id: msg.header.task_id, ...extra } })), false), 0)
    if (msg.header.action === 'run-task') {
      if (FakeSocket.failNext) {
        FakeSocket.failNext = false
        reply('task-failed', { error_code: 'InvalidParameter', error_message: 'TTS speak operation failed' })
      } else reply('task-started')
    } else if (msg.header.action === 'continue-task') {
      setTimeout(() => this.emit('message', Buffer.from([0xff, 0xfb, 1, 2]), true), 0)
      setTimeout(() => this.emit('message', Buffer.from([3, 4]), true), 1)
    } else if (msg.header.action === 'finish-task') reply('task-finished')
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  static failNext = false
}

const make = (over: Partial<ConstructorParameters<typeof QwenEngine>[0]> = {}) =>
  new QwenEngine({ key: () => 'sk-ws', host: () => 'ws-abc.ap-southeast-1.maas.aliyuncs.com', timeoutMs: () => 1000, poolSize: 2, WebSocket: FakeSocket as unknown as typeof WebSocket, ...over })

const req = { text: 'Hello.', voice: 'my-voice', model: 'qwen-audio-3.0-tts-flash', instruction: 'warm', rate: 0, pitch: 0 }

describe('QwenEngine', () => {
  it('runs one task per sentence on the workspace host and concatenates the binary frames', async () => {
    FakeSocket.instances = []
    const first = vi.fn()
    const out = await make().synth({ ...req, onFirstByte: first }, new AbortController().signal)
    expect(out).toEqual(Buffer.from([0xff, 0xfb, 1, 2, 3, 4]))
    expect(first).toHaveBeenCalledTimes(1)
    const s = FakeSocket.instances[0]!
    expect(s.url).toBe('wss://ws-abc.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference')
    expect(s.opts.headers.Authorization).toBe('bearer sk-ws')
    const run = s.sent[0]!
    expect(run.header).toMatchObject({ action: 'run-task', streaming: 'duplex' })
    expect(run.payload).toMatchObject({ task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: 'qwen-audio-3.0-tts-flash', parameters: { voice: 'my-voice', format: 'mp3', instruction: 'warm' } })
    expect(s.sent.map((m) => (m.header as { action: string }).action)).toEqual(['run-task', 'continue-task', 'finish-task'])
  })

  it('keeps the socket open between sentences instead of paying the handshake again', async () => {
    FakeSocket.instances = []
    const e = make()
    await e.synth(req, new AbortController().signal)
    await e.synth(req, new AbortController().signal)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(FakeSocket.instances[0]!.sent).toHaveLength(6)
  })

  it('reports a task failure with the provider’s code and drops that socket', async () => {
    FakeSocket.instances = []
    FakeSocket.failNext = true
    const e = make()
    await expect(e.synth(req, new AbortController().signal)).rejects.toThrow('Qwen InvalidParameter: TTS speak operation failed')
    expect(FakeSocket.instances[0]!.closed).toBe(true)
    await e.synth(req, new AbortController().signal)
    expect(FakeSocket.instances).toHaveLength(2)
  })

  it('fails fast without a key and never opens a socket', async () => {
    FakeSocket.instances = []
    await expect(make({ key: () => '' }).synth(req, new AbortController().signal)).rejects.toThrow('no API key for Qwen')
    expect(FakeSocket.instances).toHaveLength(0)
  })

  it('accepts a host given with a scheme or a path and falls back to the public endpoint', async () => {
    FakeSocket.instances = []
    await make({ host: () => 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference' }).synth(req, new AbortController().signal)
    expect(FakeSocket.instances[0]!.url).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference')
    await make({ host: () => '' }).synth(req, new AbortController().signal)
    expect(FakeSocket.instances[1]!.url).toBe('wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference')
  })
})
