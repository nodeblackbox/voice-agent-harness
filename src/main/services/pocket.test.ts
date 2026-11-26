import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PocketService, commandLine } from './pocket'

vi.mock('./log', () => ({ log: () => undefined, logAt: () => undefined }))

/** A child process that never prints and exits only when told. */
function fakeProc() {
  const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; pid: number }
  p.stdout = new EventEmitter()
  p.stderr = new EventEmitter()
  p.kill = vi.fn()
  p.pid = 4242
  return p
}

describe('PocketService', () => {
  it('uses a server the owner runs when the setting is an address, after checking it answers', async () => {
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith('/health') ? '{"status":"healthy"}' : 'RIFF', { status: 200 }))
    const spawn = vi.fn()
    const s = new PocketService({ server: () => 'http://127.0.0.1:9000/', voice: () => 'cosette', fetch: fetch as never, spawn: spawn as never })
    expect(await s.start()).toBe(true)
    expect(s.state()).toEqual({ state: 'ready', url: 'http://127.0.0.1:9000' })
    expect(spawn).not.toHaveBeenCalled()
    await s.synth('Hi.', 'marius', new AbortController().signal)
    const [url, init] = fetch.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:9000/tts')
    expect((init.body as FormData).get('voice_url')).toBe('marius')
    expect((init.body as FormData).get('text')).toBe('Hi.')
  })

  it('says plainly when the address does not answer', async () => {
    const s = new PocketService({ server: () => 'http://127.0.0.1:9', voice: () => 'cosette', fetch: (async () => Promise.reject(new Error('refused'))) as never })
    expect(await s.start()).toBe(false)
    expect(s.state()).toEqual({ state: 'failed', error: 'nothing answers at http://127.0.0.1:9/health' })
  })

  it('starts the command on a free port with the voice, and is ready once /health answers', async () => {
    const proc = fakeProc()
    const spawn = vi.fn(() => proc)
    let healthy = false
    const fetch = vi.fn(async () => (healthy ? new Response('ok') : Promise.reject(new Error('not yet'))))
    const s = new PocketService({ server: () => '', voice: () => 'cosette', env: { POCKET_TTS_COMMAND: 'uvx pocket-tts' }, spawn: spawn as never, fetch: fetch as never })
    const started = s.start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    const [cmd, args] = spawn.mock.calls[0] as unknown as [string, string[]]
    expect(cmd).toBe('uvx')
    expect(args.slice(0, 4)).toEqual(['pocket-tts', 'serve', '--host', '127.0.0.1'])
    expect(args.slice(-2)).toEqual(['--default-voice', 'cosette'])
    expect(s.state().state).toBe('loading')
    healthy = true
    expect(await started).toBe(true)
    expect(s.state()).toMatchObject({ state: 'ready', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) })
  }, 15_000)

  it('says how to fix a missing command', async () => {
    const proc = fakeProc()
    const spawn = vi.fn(() => proc)
    const s = new PocketService({ server: () => 'pocket-tts', voice: () => 'cosette', env: {}, spawn: spawn as never, fetch: (async () => Promise.reject(new Error('no'))) as never })
    const started = s.start()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    proc.emit('error', new Error('spawn pocket-tts ENOENT'))
    expect(await started).toBe(false)
    expect(s.state()).toEqual({ state: 'failed', error: '"pocket-tts" was not found: install pocket-tts or set its path in Settings > Voice output' })
  }, 15_000)
})

describe('commandLine', () => {
  it('splits a command line, keeps quoted paths whole, and is empty for nothing', () => {
    expect(commandLine('uvx pocket-tts')).toEqual(['uvx', 'pocket-tts'])
    expect(commandLine('"C:\\Program Files\\pocket tts\\pocket-tts.exe"')).toEqual(['C:\\Program Files\\pocket tts\\pocket-tts.exe'])
    expect(commandLine('  ')).toEqual([])
  })
})
