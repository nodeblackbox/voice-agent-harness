/**
 * SDK message → CcEvent conversion, shared by live sessions (manager) and saved transcripts (history).
 * Pure; inputs and outputs are clipped so events stay small enough to keep and send over IPC.
 */
import type { CcEvent } from './types'

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s)

/** Tool input for display: long strings (file contents, edits) clipped. */
export function clipInput(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = clip(v, 8000)
    else if (Array.isArray(v)) out[k] = v.slice(0, 60).map((x) => (x && typeof x === 'object' ? clipInput(x) : x))
    else out[k] = v && typeof v === 'object' ? clipInput(v) : v
  }
  return out
}

export function briefInput(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? ''
  return String(v).slice(0, 100)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : c?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n')
}

/**
 * A prompt as the user typed it: CLI wrappers removed (`<system-reminder>`, command echoes, local command
 * output). Returns '' for entries that were only wrapper noise.
 */
export function cleanPrompt(text: string): string {
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]
  if (cmd) return `${cmd.trim()}${args?.trim() ? ` ${args.trim()}` : ''}`
  return text
    .replace(/<(system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g, '')
    .trim()
}

/**
 * Events for one assistant or user message. `prompts` turns plain user text into 'user' events: on for
 * saved transcripts, off for live runs (the manager logs what it sent itself).
 */
export function messageEvents(m: any, t: number, opts: { prompts?: boolean } = {}): CcEvent[] {
  const out: CcEvent[] = []
  const content = m?.message?.content
  if (m?.type === 'assistant') {
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text?.trim()) out.push({ t, kind: 'text', text: b.text })
      else if (b?.type === 'tool_use') out.push({ t, kind: 'tool', text: `${b.name} ${briefInput(b.input)}`, tool: String(b.name), toolId: b.id, input: clipInput(b.input) })
    }
  } else if (m?.type === 'user') {
    if (typeof content === 'string') {
      const text = opts.prompts ? cleanPrompt(content) : ''
      if (text) out.push({ t, kind: 'user', text })
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_result') out.push({ t, kind: 'tool_result', text: clip(resultText(b.content), 6000), toolId: b.tool_use_id, ...(b.is_error ? { isError: true } : {}) })
        else if (opts.prompts && b?.type === 'text') {
          const text = cleanPrompt(String(b.text ?? ''))
          if (text) out.push({ t, kind: 'user', text })
        }
      }
    }
  }
  return out
}

/** A saved transcript as events. Sub-agent internals are left out; the sub-agent call and its result stay. */
export function historyEvents(messages: any[], start = 0): CcEvent[] {
  const out: CcEvent[] = []
  messages.forEach((m, i) => {
    if (m?.parent_tool_use_id) return
    out.push(...messageEvents(m, start + i, { prompts: true }))
  })
  return out
}
