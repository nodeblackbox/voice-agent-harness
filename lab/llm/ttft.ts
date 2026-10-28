// Times each stream part from a model with a voice-sized prompt and tools: where does the first byte land?
// pnpm tsx lab/llm/ttft.ts anthropic:claude-sonnet-5 [runs]
import { readFileSync } from 'node:fs'
import { streamText, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGroq } from '@ai-sdk/groq'

const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]))
const [id = 'anthropic:claude-sonnet-5', runs = '2', opt = ''] = process.argv.slice(2)
// opt: '' (provider defaults), 'low' (effort low), 'off' (thinking disabled), 'off-low'
const anthropic = { ...(opt.includes('low') ? { effort: 'low' } : {}), ...(opt.includes('off') ? { thinking: { type: 'disabled' } } : {}), ...(opt.includes('cache') ? { cacheControl: { type: 'ephemeral' } } : {}) }
const [provider, name] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
const headers = env.ANTHROPIC_WORKSPACE_ID ? { 'anthropic-workspace-id': env.ANTHROPIC_WORKSPACE_ID } : undefined
const model = provider === 'anthropic' ? createAnthropic({ apiKey: env.ANTHROPIC_API_KEY, headers })(name) : createGroq({ apiKey: (env.GROQ_KEYS || env.GROQ_API_KEY).split(',')[0] })(name)
const system = 'You are a voice assistant. Answer in one or two short spoken sentences.\n' + 'Background notes: the user manages several coding sessions by voice. '.repeat(300)
const tools = { claude_list: tool({ description: 'List coding sessions', inputSchema: z.object({}), execute: async () => ({ sessions: [{ name: 'vidgen', status: 'idle' }] }) }) }
for (let r = 0; r < Number(runs); r++) {
  const t0 = performance.now()
  const seen: string[] = []
  const res = streamText({ model, system, messages: [{ role: 'user', content: r % 2 ? 'How are my sessions doing?' : 'Can you compare the trade-offs of running four coding sessions at once versus one?' }], tools, stopWhen: stepCountIs(3), maxRetries: 0, providerOptions: { anthropic } })
  for await (const p of res.fullStream) {
    const ms = Math.round(performance.now() - t0)
    if (!seen.includes(p.type)) { seen.push(p.type); console.log(`${String(ms).padStart(6)}ms ${p.type}`) }
    if (p.type === 'error') console.log('  ', String((p.error as Error)?.message ?? p.error).slice(0, 200))
  }
  console.log(`run ${r + 1}: ${Math.round(performance.now() - t0)}ms total, usage`, JSON.stringify(await res.totalUsage), '\n')
}
