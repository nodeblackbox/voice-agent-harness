import { describe, expect, it } from 'vitest'
import type { CcEvent, CcSession } from '@shared/claude'
import { compactEvent, parseEvents, serializeEvents } from './persist'

const session = (id: string): CcSession => ({ id, name: id, workspace: `D:\\ws\\${id}`, status: 'stopped', queued: [], lastSummary: '', costUsd: 0, turns: 0, createdAt: 1, updatedAt: 1 })
const ev = (t: number, text = 'x'): CcEvent => ({ t, kind: 'text', text })

describe('session timeline persistence', () => {
  it('round-trips events per session, capped to the newest, and drops sessions that no longer exist', () => {
    const events: Record<string, CcEvent[]> = { a: [ev(1), ev(2), ev(3)], gone: [ev(9)] }
    const json = serializeEvents([session('a'), session('b')], (id) => events[id] ?? [], 2)
    expect(parseEvents(json)).toEqual({ a: [ev(2), ev(3)] })
  })

  it('compacts long texts and tool inputs for the disk copy', () => {
    const long = 'y'.repeat(5000)
    const c = compactEvent({ t: 1, kind: 'tool', text: long, tool: 'Write', input: { content: long, paths: Array.from({ length: 40 }, (_, i) => i), n: 3 } })
    expect(c.text.length).toBeLessThan(4100)
    expect(c.text).toContain('more characters')
    expect((c.input!.content as string).length).toBeLessThan(1100)
    expect(c.input!.paths).toHaveLength(20)
    expect(c.input!.n).toBe(3)
  })

  it('shrugs at a bad file: not JSON, wrong shape, or junk entries', () => {
    expect(parseEvents('nope')).toEqual({})
    expect(parseEvents('[1,2]')).toEqual({})
    expect(parseEvents(JSON.stringify({ a: 'not a list', b: [null, { t: 'x' }, ev(5)] }))).toEqual({ b: [ev(5)] })
  })
})
