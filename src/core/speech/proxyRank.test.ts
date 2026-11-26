import { describe, expect, it, vi } from 'vitest'
import { parseProxyList, proxyLabel, rankProxies, type ProxyProbe } from './proxyRank'

describe('parseProxyList', () => {
  it('turns host:port:user:pass lines into URLs and keeps URLs as they are', () => {
    const text = ['# a comment', '203.0.113.10:8080:user:p@ss', '', '  198.51.100.2:3128  ', 'http://u:p@198.51.100.3:80', 'not a proxy', '203.0.113.10:8080:user:p@ss'].join('\r\n')
    expect(parseProxyList(text)).toEqual(['http://user:p%40ss@203.0.113.10:8080', 'http://198.51.100.2:3128', 'http://u:p@198.51.100.3:80'])
  })

  it('keeps a password that contains a colon', () => {
    expect(parseProxyList('203.0.113.10:8080:user:a:b')).toEqual(['http://user:a%3Ab@203.0.113.10:8080'])
  })
})

describe('proxyLabel', () => {
  it('shows host:port without the credentials, and direct for no proxy', () => {
    expect(proxyLabel('http://user:secret@203.0.113.10:8080')).toBe('203.0.113.10:8080')
    expect(proxyLabel('')).toBe('direct')
  })
})

describe('rankProxies', () => {
  const timings: Record<string, Array<number | Error>> = {
    '': [2500, 2600, 2400],
    'http://a:1': [600, 650, 700],
    'http://b:1': [300, new Error('socket hang up'), 300],
    'http://c:1': [new Error('407'), new Error('407'), new Error('407')],
    'http://d:1': [900, 800, 1000]
  }
  const probe = (): ProxyProbe => {
    const seen: Record<string, number> = {}
    return async (url) => {
      const t = timings[url]![(seen[url] = (seen[url] ?? -1) + 1)]!
      if (t instanceof Error) throw t
      return t
    }
  }

  it('orders by median time to first audio, puts a flaky proxy after the clean ones and a dead one last', async () => {
    const ranked = await rankProxies(Object.keys(timings), probe(), { runs: 3, parallel: 2 })
    expect(ranked.map((r) => [r.label, r.firstMs, r.ok])).toEqual([
      ['a:1', 650, 3],
      ['d:1', 900, 3],
      ['direct', 2500, 3],
      ['b:1', 300, 2],
      ['c:1', null, 0]
    ])
    expect(ranked[4]!.error).toBe('407')
  })

  it('never runs more probes at once than asked', async () => {
    let live = 0
    let peak = 0
    const slow: ProxyProbe = async () => {
      peak = Math.max(peak, ++live)
      await new Promise((r) => setTimeout(r, 5))
      live--
      return 100
    }
    await rankProxies(['', 'http://a:1', 'http://b:1', 'http://c:1', 'http://d:1'], slow, { runs: 1, parallel: 2 })
    expect(peak).toBe(2)
  })

  it('stops starting new probes once aborted', async () => {
    const ac = new AbortController()
    const p = vi.fn(async () => {
      ac.abort()
      return 100
    })
    const ranked = await rankProxies(['http://a:1', 'http://b:1', 'http://c:1'], p, { runs: 3, parallel: 1, signal: ac.signal })
    expect(p).toHaveBeenCalledTimes(1)
    expect(ranked).toHaveLength(1)
  })
})
