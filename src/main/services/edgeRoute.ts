import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EdgeRouteState, ProxyRank } from '@shared/types'
import { parseProxyList, proxyLabel, rankProxies, type ProxyProbe } from '@core/speech/proxyRank'

/**
 * Which way Edge TTS goes out: your own connection or one of your proxies, picked automatically.
 *
 * Microsoft throttles the free voice per IP address, and only some of the time: measured 2026-11-20 from
 * London, a warm socket answered in ~150 ms both direct and through a Paris proxy, while the same direct
 * line had answered in 1-4 s an hour earlier. So the rule is "direct while it is quick, the fastest proxy
 * when it is not", with a ranking that is cached rather than re-run on every launch:
 *
 * - full test (every route, one run each, a few at once): when the list changes, or the ranking is a day old;
 * - quick check (direct and the best few from the ranking): at launch, and when Edge turns slow or fails;
 * - a proxy only wins when it beats direct by `marginMs`, so a tie keeps traffic off the proxies.
 */

export interface EdgeRouteOptions {
  userData: string
  /** The proxy lines to choose from (Settings list plus the fetched list URL); credentials inside. */
  lines: () => Promise<string>
  probe: ProxyProbe
  /** Country per IP, best effort ('' when unknown). */
  geo?: (hosts: string[]) => Promise<Map<string, string>>
  log?: (msg: string) => void
  trace?: (ev: string, data: Record<string, unknown>) => void
  onChange?: (s: EdgeRouteState) => void
  now?: () => number
  /** Ranking older than this gets a full test. */
  staleMs?: number
  /** How much faster than direct a proxy has to be to be used. */
  marginMs?: number
  /** Routes the quick check tries besides direct. */
  quickTop?: number
  /** At most one re-check per this long, however often Edge stumbles. */
  recheckGapMs?: number
  parallel?: () => number
}

interface Cache {
  at: number
  listHash: string
  rows: ProxyRank[]
}

const hash = (urls: string[]): string => {
  let h = 0
  for (const ch of [...urls].sort().join('\n')) h = (h * 31 + ch.charCodeAt(0)) | 0
  return `${urls.length}:${h >>> 0}`
}

export class EdgeRouteService {
  private url = ''
  private cache: Cache | null = null
  private testing: Promise<EdgeRouteState> | null = null
  private lastCheck = 0
  private note = ''
  private slowStreak = 0
  private readonly path: string

  constructor(private readonly opts: EdgeRouteOptions) {
    this.path = join(opts.userData, 'edge-routes.json')
    try {
      this.cache = JSON.parse(readFileSync(this.path, 'utf8')) as Cache
    } catch {
      this.cache = null
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** The proxy URL Edge should use right now; '' = direct. */
  current(): string {
    return this.url
  }

  state(): EdgeRouteState {
    const rows = this.cache?.rows ?? []
    const row = rows.find((r) => r.url === this.url)
    return {
      url: this.url,
      label: proxyLabel(this.url),
      country: row?.country ?? '',
      firstMs: row?.firstMs ?? null,
      directMs: rows.find((r) => !r.url)?.firstMs ?? null,
      checkedAt: this.lastCheck || this.cache?.at || 0,
      rankedAt: this.cache?.at ?? 0,
      testing: this.testing !== null,
      proxies: rows.filter((r) => r.url).length,
      note: this.note,
      rows
    }
  }

  /** At launch: a full test if the list changed or the ranking is stale, else a quick check. */
  start(): Promise<EdgeRouteState> {
    return this.check('launch')
  }

  /** Edge failed or was refused (429/403/unreachable): re-check now, without the route that just failed. */
  trouble(reason: string): void {
    void this.check(`trouble: ${reason.slice(0, 60)}`, { avoid: this.url })
  }

  /** One sentence's time to first audio; two slow ones in a row trigger a quick re-check. */
  sentence(firstByteMs: number, slowMs: number): void {
    this.slowStreak = firstByteMs > slowMs ? this.slowStreak + 1 : 0
    if (this.slowStreak >= 2) {
      this.slowStreak = 0
      void this.check(`slow: ${Math.round(firstByteMs)} ms to first audio`)
    }
  }

  /** Settings "Test all": every route, now. */
  retestAll(): Promise<EdgeRouteState> {
    return this.check('manual', { full: true, force: true })
  }

  private async check(reason: string, o: { full?: boolean; force?: boolean; avoid?: string } = {}): Promise<EdgeRouteState> {
    if (this.testing) return this.testing
    if (!o.force && reason !== 'launch' && this.now() - this.lastCheck < (this.opts.recheckGapMs ?? 120_000)) return this.state()
    this.testing = this.run(reason, o).finally(() => {
      this.testing = null
      this.opts.onChange?.(this.state())
    })
    this.opts.onChange?.(this.state())
    return this.testing
  }

  private async run(reason: string, o: { full?: boolean; avoid?: string }): Promise<EdgeRouteState> {
    const t0 = this.now()
    let urls: string[]
    try {
      urls = parseProxyList(await this.opts.lines())
    } catch (e) {
      this.note = `Couldn't load the proxy list: ${(e as Error).message}`
      return this.state()
    }
    if (!urls.length) {
      this.url = ''
      this.note = 'No proxies listed; Edge goes direct.'
      return this.state()
    }
    const listHash = hash(urls)
    const stale = !this.cache || this.cache.listHash !== listHash || t0 - this.cache.at > (this.opts.staleMs ?? 24 * 3600_000)
    const full = o.full || stale
    const known = new Set(urls)
    let candidates: string[]
    if (full) candidates = urls
    else {
      const top = (this.cache?.rows ?? []).filter((r) => r.url && known.has(r.url) && r.firstMs !== null && r.url !== o.avoid)
      candidates = top.slice(0, this.opts.quickTop ?? 3).map((r) => r.url)
    }
    const rows = await rankProxies(['', ...candidates], this.opts.probe, { runs: full ? 1 : 2, parallel: this.opts.parallel?.() ?? 4 })
    if (full) {
      const geo = await this.opts.geo?.(urls.map((u) => new URL(u).hostname)).catch(() => new Map<string, string>())
      for (const r of rows) r.country = r.url ? (geo?.get(new URL(r.url).hostname) ?? '') : ''
      this.cache = { at: this.now(), listHash, rows }
    } else if (this.cache) {
      // fold the fresh numbers into the ranking so the next quick check starts from them
      const fresh = new Map(rows.map((r) => [r.url, r]))
      const merged = this.cache.rows.map((r) => (fresh.has(r.url) ? { ...fresh.get(r.url)!, country: r.country } : r))
      const failed = (r: ProxyRank): number => (r.firstMs === null ? 2 : r.ok < r.runs ? 1 : 0)
      this.cache = { ...this.cache, rows: merged.sort((a, b) => failed(a) - failed(b) || (a.firstMs ?? 0) - (b.firstMs ?? 0)) }
    }
    this.save()
    this.lastCheck = this.now()
    const prev = this.url
    this.url = choose(rows, this.opts.marginMs ?? 150, o.avoid)
    const pick = rows.find((r) => r.url === this.url)
    const direct = rows.find((r) => !r.url)
    this.note = this.url
      ? `Through ${proxyLabel(this.url)}${pick?.country ? ` (${pick.country})` : ''}: ${pick?.firstMs} ms to first audio; direct ${direct?.firstMs != null ? `${direct.firstMs} ms` : 'failed'}.`
      : `Direct: ${direct?.firstMs ?? '?'} ms to first audio${rows.length > 1 ? `; no proxy was ${this.opts.marginMs ?? 150} ms faster` : ''}.`
    this.opts.log?.(`edge route (${reason}, ${full ? 'full' : 'quick'} test of ${rows.length} in ${this.now() - t0} ms): ${this.note}`)
    this.opts.trace?.('tts.route', { reason, full, tested: rows.length, url: proxyLabel(this.url), firstMs: pick?.firstMs ?? null, directMs: direct?.firstMs ?? null, changed: prev !== this.url, ms: this.now() - t0 })
    return this.state()
  }

  private save(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.cache))
    } catch (e) {
      this.opts.log?.(`couldn't save the edge route ranking: ${(e as Error).message}`)
    }
  }
}

/**
 * Direct unless a proxy that answered every run beats it by `marginMs` (or direct failed). `avoid` is the
 * route that just failed: it is only chosen when nothing else answered ('' = direct failed, so any clean
 * proxy wins).
 */
export function choose(rows: ProxyRank[], marginMs: number, avoid?: string): string {
  const clean = rows.filter((r) => r.firstMs !== null && r.ok === r.runs)
  const direct = clean.find((r) => !r.url)
  const best = clean.find((r) => r.url && r.url !== avoid) ?? clean.find((r) => r.url)
  if (!best) return ''
  // direct is what just failed (a 429 can come and go between two tests): take the proxy while it lasts
  if (avoid === '') return best.url
  if (direct && direct.firstMs! <= best.firstMs! + marginMs) return ''
  return best.url
}

/** Countries for a batch of IPs from ip-api.com (the IPs only; no credentials). */
export async function ipCountries(hosts: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const res = await fetch('http://ip-api.com/batch?fields=query,countryCode,city', {
    method: 'POST',
    body: JSON.stringify([...new Set(hosts)].slice(0, 100)),
    signal: AbortSignal.timeout(8000)
  })
  for (const g of (await res.json()) as Array<{ query: string; countryCode?: string; city?: string }>) if (g.countryCode) out.set(g.query, `${g.countryCode}${g.city ? ` ${g.city}` : ''}`)
  return out
}
