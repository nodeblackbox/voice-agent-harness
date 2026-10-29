/** Shared helpers for the Claude Agent SDK lab. Run with `pnpm lab:<name>`. Everything happens inside WORKSPACE. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// A stale ANTHROPIC_API_KEY in the shell makes the CLI answer "Invalid API key" instead of using the
// ambient `claude` login (what the Python lab relied on). Drop it for this process only.
delete process.env.ANTHROPIC_API_KEY

export const WORKSPACE = process.env.LAB_WORKSPACE ?? path.join(os.tmpdir(), 'voice-agent-lab')
export const MODEL = process.env.LAB_MODEL ?? 'claude-haiku-4-5-20251001'

export function freshWorkspace(name: string): string {
  const dir = path.join(WORKSPACE, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A push-able async iterable, used as the SDK's streaming-input prompt. */
export function inputStream() {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let closed = false
  return {
    push(text: string, sessionId = '') {
      queue.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: sessionId })
      wake?.()
    },
    close() { closed = true; wake?.() },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift() as never
        if (closed) return
        await new Promise<void>((r) => { wake = r })
        wake = null
      }
    },
  }
}

export const t0 = Date.now()
export const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a)

/** One-line description of an SDK message. */
export function describe(m: any): string {
  if (m.type === 'system') return `system/${m.subtype}${m.session_id ? ' sid=' + String(m.session_id).slice(0, 8) : ''}`
  if (m.type === 'assistant') {
    return 'assistant: ' + (m.message?.content ?? []).map((b: any) =>
      b.type === 'text' ? `"${String(b.text).slice(0, 90)}"` : b.type === 'tool_use' ? `tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 100)}` : b.type).join(' | ')
  }
  if (m.type === 'user') return 'user/tool_result'
  if (m.type === 'result') return `result/${m.subtype} terminal=${m.terminal_reason ?? '-'} cost=$${m.total_cost_usd?.toFixed?.(4)} turns=${m.num_turns}`
  return m.type
}

export function finding(id: string, text: string) {
  const f = path.join(import.meta.dirname, 'FINDINGS.md')
  fs.appendFileSync(f, `\n- **${id}** (${new Date().toISOString().slice(0, 16)}): ${text}\n`)
  log('FINDING', id, text)
}
