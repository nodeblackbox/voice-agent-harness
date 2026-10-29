#!/usr/bin/env node
// Compare time-to-first-audio across the voice engines you have keys for, and across proxies for Edge TTS.
//
//   pnpm tts:latency                       every engine with a key in .env, direct
//   pnpm tts:latency -- --proxies proxies.txt --runs 3
//   pnpm tts:latency -- --only edge,inworld --text "Hey, how are you doing today?"
//
// proxies.txt: one per line, `host:port:user:pass` or a full http://user:pass@host:port URL (keep it out of git;
// it is in .gitignore). Nothing here prints a key or a proxy password.
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts'

// the engines are the app's own TypeScript; bundle them into node_modules/.cache (so their imports resolve) and import that
const root = resolve(import.meta.dirname, '..')
const outdir = join(root, 'node_modules', '.cache', 'voice-agent-tts-lab')
mkdirSync(outdir, { recursive: true })
await build({
  stdin: {
    contents: "export * from './src/core/speech/cloud'; export * from './src/core/speech/qwen'; export * from './src/shared/tts'",
    resolveDir: root,
    loader: 'ts'
  },
  outfile: join(outdir, 'lab.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external',
  alias: { '@shared': join(root, 'src/shared'), '@core': join(root, 'src/core') },
  logLevel: 'silent'
})
const { ElevenLabsEngine, FishEngine, InworldEngine, QwenEngine, TTS_PROVIDERS, QWEN_DEFAULT_HOST } = await import(pathToFileURL(join(outdir, 'lab.mjs')).href)

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : def
}
const runs = Number(opt('runs', 2))
const text = opt('text', 'Hey, how are you doing today? The login fix is done and the tests pass.')
const only = opt('only', '')?.split(',').filter(Boolean)
const proxyFile = opt('proxies', '')

const env = { ...process.env }
if (existsSync('.env')) {
  for (const raw of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const i = line.indexOf('=')
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
}
const keyFor = (p) => TTS_PROVIDERS[p].envKeys.map((k) => env[k]).find(Boolean) ?? ''
const proxies = proxyFile
  ? readFileSync(proxyFile, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => (l.startsWith('http') ? l : (([h, p, u, pw]) => `http://${encodeURIComponent(u)}:${encodeURIComponent(pw)}@${h}:${p}`)(l.split(':'))))
  : []
const label = (url) => url.replace(/\/\/.*@/, '//')

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return { min: s[0], med: s[Math.floor(s.length / 2)], max: s[s.length - 1] }
}
const fmt = (ms) => (ms === undefined ? '   -  ' : `${String(Math.round(ms)).padStart(5)}ms`)
const rows = []
const report = (name, firsts, totals, note = '') => {
  if (!firsts.length) return rows.push([name, '  failed', '', note])
  const f = stats(firsts)
  const t = stats(totals)
  rows.push([name, fmt(f.med), fmt(t.med), `${firsts.length}/${runs} ok, first ${fmt(f.min).trim()}–${fmt(f.max).trim()}${note ? `, ${note}` : ''}`])
}

async function timed(fn) {
  const t0 = performance.now()
  let first
  await fn((ms) => (first = ms))
  return { first, total: performance.now() - t0 }
}

async function edge(proxy) {
  const firsts = []
  const totals = []
  let note = ''
  for (let i = 0; i < runs; i++) {
    const tts = new MsEdgeTTS(proxy ? { agent: new HttpsProxyAgent(proxy) } : undefined)
    try {
      const r = await timed(async (onFirst) => {
        const t0 = performance.now()
        await tts.setMetadata('en-US-AvaNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3)
        const { audioStream } = tts.toStream(text)
        await new Promise((res, rej) => {
          let seen = false
          audioStream.on('data', () => {
            if (!seen) {
              seen = true
              onFirst(performance.now() - t0)
            }
          })
          audioStream.on('end', res)
          audioStream.on('close', res)
          audioStream.on('error', rej)
          setTimeout(() => rej(new Error('timeout')), 15000)
        })
      })
      firsts.push(r.first)
      totals.push(r.total)
    } catch (e) {
      note = String(e.message).slice(0, 60)
    } finally {
      try {
        tts.close()
      } catch {}
    }
  }
  report(`edge ${proxy ? label(proxy) : 'direct'}`, firsts, totals, note)
}

async function cloud(p, engine, req) {
  const firsts = []
  const totals = []
  let note = ''
  for (let i = 0; i < runs; i++) {
    try {
      const r = await timed(async (onFirst) => {
        await engine.synth({ ...req, onFirstByte: onFirst }, AbortSignal.timeout(20000))
      })
      firsts.push(r.first)
      totals.push(r.total)
    } catch (e) {
      note = String(e.message).slice(0, 70)
    }
  }
  report(`${p} ${req.model} / ${req.voice.slice(0, 20)}`, firsts, totals, note)
}

const want = (p) => !only?.length || only.includes(p)
if (want('edge')) {
  await edge()
  for (const px of proxies) await edge(px)
}
const choice = (p) => ({ voice: env[TTS_PROVIDERS[p].envVoice] || TTS_PROVIDERS[p].defaultVoice, model: env[TTS_PROVIDERS[p].envModel] || TTS_PROVIDERS[p].defaultModel, rate: 0, pitch: 0, text })
const viaProxy = proxies[0] && args.includes('--cloud-proxy') ? proxies[0] : ''
const cloudFetch = viaProxy ? (u, i) => undiciFetch(u, { ...i, dispatcher: new ProxyAgent(viaProxy) }) : undefined
const deps = (p) => ({ key: () => keyFor(p), fetch: cloudFetch, timeoutMs: () => 20000 })
const engines = { elevenlabs: () => new ElevenLabsEngine(deps('elevenlabs')), fish: () => new FishEngine(deps('fish')), inworld: () => new InworldEngine(deps('inworld')) }
for (const [p, make] of Object.entries(engines)) if (want(p) && keyFor(p)) await cloud(p, make(), choice(p))
if (want('qwen') && keyFor('qwen')) {
  const q = new QwenEngine({ key: () => keyFor('qwen'), host: () => env.DASHSCOPE_HOST || QWEN_DEFAULT_HOST, agent: viaProxy ? () => new HttpsProxyAgent(viaProxy) : undefined, timeoutMs: () => 20000 })
  await cloud('qwen', q, choice('qwen'))
  q.reset()
}

console.log(`\n${runs} run(s) each, "${text.slice(0, 40)}…"\n`)
console.log(`${'route'.padEnd(46)} ${'first audio'.padStart(11)} ${'total'.padStart(8)}  notes`)
for (const [name, f, t, n] of rows) console.log(`${name.padEnd(46)} ${f.padStart(11)} ${t.padStart(8)}  ${n}`)
const skipped = Object.keys(TTS_PROVIDERS).filter((p) => want(p) && !keyFor(p))
if (skipped.length) console.log(`\nno key, skipped: ${skipped.join(', ')}`)
