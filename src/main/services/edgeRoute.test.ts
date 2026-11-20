import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProxyRank } from '@shared/types'
import { EdgeRouteService, choose } from './edgeRoute'

const A = 'http://u:p@203.0.113.10:8080'
const B = 'http://u:p@203.0.113.11:8080'
const C = 'http://u:p@198.51.100.2:3128'
const LIST = ['203.0.113.10:8080:u:p', '203.0.113.11:8080:u:p', '198.51.100.2:3128:u:p'].join('\n')

const row = (url: string, firstMs: number | null, ok = 1, runs = 1): ProxyRank => ({ url, label: url || 'direct', firstMs, ok, runs })

describe('choose', () => {
  it('stays direct when no proxy beats it by the margin', () => {
    expect(choose([row(A, 140), row('', 150)], 150)).toBe('')
  })

  it('takes the fastest proxy when direct is throttled', () => {
    expect(choose([row(A, 600), row(B, 700), row('', 2500)], 150)).toBe(A)
  })

  it('takes a proxy when direct failed outright', () => {
    expect(choose([row(A, 600), row('', null, 0)], 150)).toBe(A)
  })

  it('skips a proxy that failed a run', () => {
    expect(choose([row(A, 300, 1, 2), row(B, 500, 2, 2), row('', 3000, 2, 2)], 150)).toBe(B)
  })

  it('avoids the route that just failed, and leaves direct when direct is the one that failed', () => {
    expect(choose([row(A, 300), row(B, 500), row('', 3000)], 150, A)).toBe(B)
    expect(choose([row(A, 300), row('', 200)], 150, '')).toBe(A)
  })

  it('goes direct when nothing answered', () => {
    expect(choose([row(A, null, 0), row('', null, 0)], 150)).toBe('')
  })
})

describe('EdgeRouteService', () => {
  const setup = (times: Record<string, number | null>, over: Partial<ConstructorParameters<typeof EdgeRouteService>[0]> = {}) => {
    const probed: string[] = []
    let clock = 1_000_000
    const svc = new EdgeRouteService({
      userData: mkdtempSync(join(tmpdir(), 'route-')),
      lines: async () => LIST,
      probe: async (url) => {
        probed.push(url)
        const t = times[url]
        if (t === null || t === undefined) throw new Error('refused')
        return t
      },
      geo: async () => new Map([['203.0.113.10', 'FR Paris']]),
      now: () => clock,
      ...over
    })
    return { svc, probed, tick: (ms: number) => (clock += ms) }
  }

  it('tests every route on first launch, then only direct and the best few', async () => {
    const { svc, probed, tick } = setup({ '': 2400, [A]: 600, [B]: 650, [C]: 900 })
    const s = await svc.start()
    expect(probed.sort()).toEqual(['', A, B, C].sort())
    expect(s.url).toBe(A)
    expect(s.country).toBe('FR Paris')
    expect(s.proxies).toBe(3)

    probed.length = 0
    tick(60_000)
    const fresh = new EdgeRouteService({ userData: (svc as unknown as { path: string }).path.replace(/[\\/]edge-routes\.json$/, ''), lines: async () => LIST, probe: async (u) => (probed.push(u), u ? 600 : 2400), now: () => 1_060_000, quickTop: 2 })
    await fresh.start()
    // the ranking was cached on disk: two proxies plus direct, two runs each
    expect(new Set(probed)).toEqual(new Set(['', A, B]))
    expect(probed).toHaveLength(6)
  })

  it('a changed list gets a full test again', async () => {
    let list = LIST
    const { svc, probed } = setup({ '': 150, [A]: 600, [B]: 650, [C]: 900 }, { lines: async () => list })
    await svc.start()
    probed.length = 0
    list = LIST.split('\n').slice(0, 2).join('\n')
    await svc.start()
    expect(new Set(probed)).toEqual(new Set(['', A, B]))
    expect(svc.current()).toBe('')
  })

  it('two slow sentences re-check, and a refusal moves off the failing route', async () => {
    const times: Record<string, number | null> = { '': 150, [A]: 600, [B]: 650, [C]: 900 }
    const { svc, tick } = setup(times)
    await svc.start()
    expect(svc.current()).toBe('')

    times[''] = 3000
    tick(200_000)
    svc.sentence(2500, 1200)
    svc.sentence(2600, 1200)
    await new Promise((r) => setTimeout(r, 0))
    await svc.retestAll() // waits for the running check
    expect(svc.current()).toBe(A)

    tick(200_000)
    times[A] = null
    svc.trouble('429 Too Many Requests')
    await new Promise((r) => setTimeout(r, 0))
    await svc.retestAll()
    expect(svc.current()).toBe(B)
  })

  it('rate-limits re-checks', async () => {
    const { svc, probed } = setup({ '': 150, [A]: 600, [B]: 650, [C]: 900 })
    await svc.start()
    probed.length = 0
    svc.trouble('timeout')
    svc.trouble('timeout')
    await new Promise((r) => setTimeout(r, 0))
    expect(probed).toHaveLength(0)
  })

  it('no proxies: direct, and says so', async () => {
    const { svc, probed } = setup({}, { lines: async () => '' })
    const s = await svc.start()
    expect(s.url).toBe('')
    expect(s.note).toMatch(/No proxies/)
    expect(probed).toHaveLength(0)
  })
})
