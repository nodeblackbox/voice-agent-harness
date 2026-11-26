/** Simulate reply turns through Edge: 3 sentences synthesized at once (like the app's pool), first-byte per sentence. */
import { readFileSync } from 'node:fs'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { EdgeTtsEngine } from '../src/core/speech/tts'
import { parseProxyList, proxyLabel } from '../src/core/speech/proxyRank'

const SENTENCES = [
  'Alright, so here is the thing about that idea you mentioned earlier.',
  'It should work, but we need to test the latency first before we commit.',
  'Let me know if you want me to run the numbers again with a few more proxies.'
]
// pnpm lab:edge-turns [rounds] [proxies.txt]: direct against the first proxy and the first three spread over the pool
// (put the fastest first, e.g. from pnpm lab:proxies).
const all = parseProxyList(readFileSync(process.argv[3] ?? 'proxies.txt', 'utf8'))
const routes: Record<string, string[]> = {
  direct: [''],
  'first proxy': all.slice(0, 1),
  'first 3 spread': all.slice(0, 3)
}
const rounds = Number(process.argv[2] ?? 4)
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function run(name: string, urls: string[]) {
  const engines = urls.map((u) => { const a = u ? new HttpsProxyAgent(u) : undefined; return new EdgeTtsEngine(3, 12000, () => a) })
  const first: number[] = [], total: number[] = []
  let fails = 0
  for (let r = 0; r < rounds; r++) {
    await Promise.all(SENTENCES.map(async (text, i) => {
      const e = engines[i % engines.length]!
      const t0 = performance.now(); let fb: number | null = null
      try {
        const buf = await e.synth({ text, voice: 'en-US-AvaNeural', rate: 0.15, pitch: 0, onFirstByte: () => (fb ??= performance.now() - t0) }, AbortSignal.timeout(15000))
        if (!buf?.length) throw new Error('empty')
        first.push(fb!); total.push(performance.now() - t0)
      } catch { fails++ }
    }))
  }
  for (const e of engines) e.close()
  console.log(`${name.padEnd(22)} first byte median ${Math.round(med(first))} ms (worst ${Math.round(Math.max(...first))}), whole sentence median ${Math.round(med(total))} ms, fails ${fails}/${rounds * 3}   [${urls.map(proxyLabel).join(', ')}]`)
}
for (const [n, u] of Object.entries(routes)) await run(n, u)
