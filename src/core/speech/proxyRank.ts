import type { ProxyRank } from '@shared/types'
import { EdgeTtsEngine } from './tts'

/**
 * "Find fastest" for the Edge proxy: time a short phrase through each proxy (and direct, for comparison)
 * and rank by the median time to first audio. Microsoft throttles the free voice per IP, so the spread is
 * large: a few hundred milliseconds through a nearby proxy against seconds on a throttled address.
 */

/** One proxy per line: host:port, host:port:user:pass, or an http(s):// URL. Blank lines and # comments are skipped. */
export function parseProxyList(text: string): string[] {
  const out = new Set<string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^https?:\/\//i.test(line)) {
      out.add(line)
      continue
    }
    const [host, port, user, ...pass] = line.split(':')
    if (!host || !port || !/^\d+$/.test(port)) continue
    out.add(user ? `http://${encodeURIComponent(user)}:${encodeURIComponent(pass.join(':'))}@${host}:${port}` : `http://${host}:${port}`)
  }
  return [...out]
}

/** host:port of a proxy URL without its credentials; '' is the direct connection. */
export function proxyLabel(url: string): string {
  if (!url) return 'direct'
  try {
    return new URL(url).host
  } catch {
    return url.replace(/\/\/.*@/, '//')
  }
}

/** Milliseconds to the first audio through `url` ('' = direct); throws when no audio came. */
export type ProxyProbe = (url: string, signal: AbortSignal) => Promise<number>

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}

/**
 * Probe every url `runs` times, `parallel` urls at once, fastest first. A route that failed a run sorts
 * after every route that never failed, so a flaky proxy cannot win on one lucky answer.
 */
export async function rankProxies(urls: string[], probe: ProxyProbe, opts: { runs: number; parallel: number; signal?: AbortSignal }): Promise<ProxyRank[]> {
  const signal = opts.signal ?? new AbortController().signal
  const results: ProxyRank[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < urls.length && !signal.aborted) {
      const url = urls[next++]!
      const times: number[] = []
      let error: string | undefined
      for (let i = 0; i < opts.runs && !signal.aborted; i++) {
        try {
          times.push(await probe(url, signal))
        } catch (e) {
          error = String((e as Error).message ?? e).slice(0, 120)
        }
      }
      results.push({ url, label: proxyLabel(url), firstMs: times.length ? Math.round(median(times)) : null, ok: times.length, runs: opts.runs, ...(error ? { error } : {}) })
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel, urls.length)) }, worker))
  const failed = (r: ProxyRank): number => (r.firstMs === null ? 2 : r.ok < r.runs ? 1 : 0)
  return results.sort((a, b) => failed(a) - failed(b) || (a.firstMs ?? 0) - (b.firstMs ?? 0))
}

/**
 * A probe that speaks one short phrase in `voice` on a fresh Edge socket through the agent `agentFor(url)`
 * builds, timing from before the socket opens (a throttled address is slow at the handshake too).
 */
export function edgeProbe(agentFor: (url: string) => unknown, voice: string | (() => string), timeoutMs: number): ProxyProbe {
  return async (url, signal) => {
    const agent = url ? agentFor(url) : undefined
    const engine = new EdgeTtsEngine(1, timeoutMs, () => agent)
    const t0 = performance.now()
    let first: number | null = null
    try {
      await engine.synth({ text: 'Testing the voice.', voice: typeof voice === 'function' ? voice() : voice, rate: 0, pitch: 0, onFirstByte: () => (first ??= performance.now() - t0) }, signal)
    } finally {
      engine.close()
    }
    if (first === null) throw new Error('no audio')
    return first
  }
}
