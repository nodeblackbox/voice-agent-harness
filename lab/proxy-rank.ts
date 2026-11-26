/**
 * Time Edge TTS through your own connection and every proxy in a list, grouped by country.
 *   pnpm lab:proxies [proxies.txt] [--runs 3] [--parallel 4]
 * The list defaults to proxies.txt (ignored by git); WEBSHARE_PROXY_LIST_URL in .env is fetched when that file is missing.
 * Countries come from one ip-api.com batch lookup of the proxy IPs (no credentials leave this machine).
 */
import { readFileSync, existsSync } from 'node:fs'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { edgeProbe, parseProxyList, proxyLabel, rankProxies } from '../src/core/speech/proxyRank'

const args = process.argv.slice(2)
const flag = (name: string, dflt: number): number => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? Number(args[i + 1]) : dflt
}
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'proxies.txt'

function envValue(key: string): string | undefined {
  if (!existsSync('.env')) return undefined
  const line = readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${key}=`))
  return line?.slice(key.length + 1).trim()
}

async function main(): Promise<void> {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!text) {
    const url = envValue('WEBSHARE_PROXY_LIST_URL')
    if (!url) throw new Error(`no ${file} and no WEBSHARE_PROXY_LIST_URL in .env`)
    text = await (await fetch(url)).text()
  }
  const urls = parseProxyList(text)
  const hosts = urls.map((u) => new URL(u).hostname)
  const geo = new Map<string, string>()
  try {
    const res = await fetch('http://ip-api.com/batch', { method: 'POST', body: JSON.stringify(hosts.map((query) => ({ query, fields: 'query,countryCode,city' }))) })
    for (const g of (await res.json()) as Array<{ query: string; countryCode?: string; city?: string }>) geo.set(g.query, `${g.countryCode ?? '??'} ${g.city ?? ''}`.trim())
  } catch {
    /* countries are a nicety */
  }
  const runs = flag('runs', 3)
  const parallel = flag('parallel', 4)
  console.log(`testing direct + ${urls.length} proxies, ${runs} runs each, ${parallel} at once`)
  const t0 = Date.now()
  const probe = edgeProbe((u) => new HttpsProxyAgent(u), 'en-US-AvaNeural', 12_000)
  const ranked = await rankProxies(['', ...urls], probe, { runs, parallel })
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`)
  const where = (url: string): string => (url ? geo.get(new URL(url).hostname) ?? '' : 'your connection')
  for (const [i, r] of ranked.entries()) {
    console.log(`${String(i + 1).padStart(3)}  ${r.label.padEnd(22)} ${where(r.url).padEnd(20)} ${(r.firstMs === null ? 'failed' : `${r.firstMs} ms`).padStart(8)}  ${r.ok}/${r.runs}${r.error ? `  ${r.error.slice(0, 50)}` : ''}`)
  }
  const byCountry = new Map<string, number[]>()
  for (const r of ranked) {
    if (!r.url || r.firstMs === null) continue
    const c = where(r.url).split(' ')[0] || '??'
    byCountry.set(c, [...(byCountry.get(c) ?? []), r.firstMs])
  }
  console.log('\nby country (median of medians, best):')
  for (const [c, xs] of [...byCountry].sort((a, b) => med(a[1]) - med(b[1]))) console.log(`  ${c}  ${med(xs)} ms median, ${Math.min(...xs)} ms best, ${xs.length} answered`)
  void proxyLabel
}

const med = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
