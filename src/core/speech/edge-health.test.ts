import { describe, expect, it } from 'vitest'
import { EdgeHealth } from './edge-health'

const MIN = 60_000

describe('EdgeHealth', () => {
  it('stays down after a failure until a probe succeeds (no timed flip back)', async () => {
    let t = 0
    const h = new EdgeHealth(() => t)
    expect(h.down).toBe(false)
    h.fail('websocket error')
    t += 10 * MIN
    expect(h.down).toBe(true) // still down long after the wait: only a probe brings it back
    expect(await h.probe(async () => undefined)).toEqual({ ok: true })
    expect(h.down).toBe(false)
  })

  it('backs off: rate limiting waits longer, doubles, and caps at 30 minutes', async () => {
    let t = 0
    const h = new EdgeHealth(() => t)
    expect(h.fail('Unexpected server response: 429')).toBe(5 * MIN)
    expect(h.probeDue()).toBe(false)
    t += 5 * MIN
    expect(h.probeDue()).toBe(true)
    const r = await h.probe(async () => { throw new Error('Unexpected server response: 429') })
    expect(r).toMatchObject({ ok: false, waitMs: 10 * MIN })
    expect(h.fail('429')).toBe(20 * MIN)
    expect(h.fail('429')).toBe(30 * MIN)
    const plain = new EdgeHealth(() => 0)
    expect(plain.fail('timeout')).toBe(MIN)
    expect(plain.fail('timeout')).toBe(2 * MIN)
  })

  it('runs one probe at a time and none before it is due', async () => {
    let t = 0
    const h = new EdgeHealth(() => t)
    expect(await h.probe(async () => undefined)).toEqual({ ok: false }) // not down: nothing to probe
    h.fail('x')
    t += MIN
    let release!: () => void
    const first = h.probe(() => new Promise<void>((r) => { release = r }))
    expect(h.probeDue()).toBe(false)
    release()
    expect(await first).toEqual({ ok: true })
  })
})
