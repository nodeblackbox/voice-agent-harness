import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./log', () => ({ log: () => undefined, logAt: () => undefined }))

import { KokoroService, type KokoroState } from './kokoro'

const fakeChild = () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() })
  return child
}

describe('KokoroService state', () => {
  it('goes loading then ready, and tells listeners', async () => {
    const child = fakeChild()
    const svc = new KokoroService({ projectRoot: '.', python: () => 'py', voice: () => 'af_heart', spawn: (() => child) as never })
    const seen: KokoroState['state'][] = []
    svc.onState((s) => seen.push(s.state))
    const p = svc.start()
    expect(svc.state().state).toBe('loading')
    child.stdout.write('INFO mouth: ready\nMOUTH_PORT 4321\n')
    expect(await p).toBe(true)
    expect(svc.state()).toEqual({ state: 'ready' })
    expect(seen).toEqual(['loading', 'ready'])
  })

  it('a failed load reports why, backs off, and a forced start retries at once', async () => {
    const children = [fakeChild(), fakeChild()]
    let n = 0
    const svc = new KokoroService({ projectRoot: '.', python: () => 'py', voice: () => 'af_heart', spawn: (() => children[n++]) as never })
    const p = svc.start()
    children[0]!.emit('exit', 1)
    expect(await p).toBe(false)
    expect(svc.state()).toEqual({ state: 'failed', error: 'exited with code 1 while loading' })
    expect(await svc.start()).toBe(false) // backing off
    expect(n).toBe(1)
    const q = svc.start({ force: true })
    expect(n).toBe(2)
    children[1]!.stdout.write('MOUTH_PORT 5555\n')
    expect(await q).toBe(true)
  })
})
