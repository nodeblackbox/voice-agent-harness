import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ClaudeSessionManager } from '../claude/manager'
import type { CcSession } from '../claude/types'

const sessionRef = z.string().default('').describe('Session name (or part of it). Leave empty when there is only one session.')

/** What the voice model is told about a session: short, speakable, no internals. */
function brief(s: CcSession, m: ClaudeSessionManager) {
  return {
    name: s.name,
    status: s.status,
    workspace: s.workspace,
    waiting_for_user: s.pending
      ? s.pending.kind === 'question'
        ? { type: 'question', questions: s.pending.questions.map((q) => ({ question: q.question, options: q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` (${o.description})` : ''}`), multi_select: q.multiSelect })) }
        : { type: 'approval', what: s.pending.summary }
      : null,
    queued_prompts: s.queued.length,
    what_just_happened: m.digest(s.id),
    cost_usd: Number(s.costUsd.toFixed(3))
  }
}

/**
 * Voice-callable control of Claude Code sessions. Every tool returns immediately (sessions run in the
 * background and report back through events), so the 25 s tool-stall timeout never applies.
 */
export function claudeTools(m: ClaudeSessionManager): ToolSet {
  const find = (ref: string) => m.find(ref)

  return {
    claude_list: tool({
      description: 'List the Claude Code sessions: name, status, what is waiting on the user, and what just happened in each.',
      inputSchema: z.object({}),
      execute: async () => ({ sessions: m.list().map((s) => brief(s, m)) })
    }),

    claude_start: tool({
      description:
        'Start a NEW Claude Code session in its own sandboxed workspace folder and optionally give it a first task. Use when the user wants something built or investigated in a fresh session. Pick a short, spoken-friendly name (e.g. "landing page").',
      inputSchema: z.object({
        name: z.string().min(1).describe('Short session name'),
        task: z.string().default('').describe('The first instruction for Claude Code. Full, self-contained, written as a clear brief.')
      }),
      execute: async ({ name, task }) => {
        const r = m.start(name, task || undefined)
        return r.ok ? { status: 'started', session: brief(r.session, m) } : { status: 'failed', error: r.error }
      }
    }),

    claude_send: tool({
      description:
        'Give an existing session another instruction. If it is busy the instruction is queued behind the current work (stacked prompts). Set mode "now" only when the user wants to stop what it is doing and switch to this instead.',
      inputSchema: z.object({
        session: sessionRef,
        prompt: z.string().min(1).describe('The instruction, self-contained'),
        mode: z.enum(['queue', 'now']).default('queue')
      }),
      execute: async ({ session, prompt, mode }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const r = m.send(f.session.id, prompt, { now: mode === 'now' })
        return r.ok ? { status: r.queued ? 'queued' : mode === 'now' ? 'redirecting' : 'sent', session: f.session.name } : { status: 'failed', error: r.error }
      }
    }),

    claude_status: tool({
      description: 'What a session is doing right now and what just happened in it. Use when the user asks how it is going, what it did, or what it is asking.',
      inputSchema: z.object({ session: sessionRef }),
      execute: async ({ session }) => {
        const f = find(session)
        return f.ok ? brief(f.session, m) : { status: 'failed', error: f.error }
      }
    }),

    claude_answer: tool({
      description:
        'Answer what a session is waiting on. For a multiple-choice question give the option number(s) ("choice") or free text ("text") for something else. For a yes/no approval give approve true or false. Only call this when the user has actually answered; never guess an answer on their behalf.',
      inputSchema: z.object({
        session: sessionRef,
        choice: z.array(z.number().int().min(1)).optional().describe('1-based option number(s); several only for multi-select; one per question when there are several questions'),
        text: z.string().optional().describe('A free-text answer instead of an option'),
        approve: z.boolean().optional().describe('For approvals: true = allow, false = deny')
      }),
      execute: async ({ session, choice, text, approve }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const a = approve !== undefined ? (approve ? ({ kind: 'allow' } as const) : ({ kind: 'deny' } as const)) : choice?.length ? ({ kind: 'choice', choices: choice } as const) : text ? ({ kind: 'text', text } as const) : null
        if (!a) return { status: 'failed', error: 'No answer was given.' }
        const r = m.answer(f.session.id, a)
        return r.ok ? { status: 'answered', session: f.session.name, answer: r.said } : { status: 'failed', error: r.error }
      }
    }),

    claude_interrupt: tool({
      description: 'Stop a session mid-task without ending it ("hold on", "stop that"). It stays resumable and can be given a new instruction. clear_queue also drops any stacked prompts.',
      inputSchema: z.object({ session: sessionRef, clear_queue: z.boolean().default(false) }),
      execute: async ({ session, clear_queue }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const r = await m.interrupt(f.session.id, { clearQueue: clear_queue })
        return r.ok ? { status: 'interrupted', session: f.session.name } : { status: 'failed', error: r.error }
      }
    }),

    claude_stop: tool({
      description: 'Shut a session down completely. Its workspace and history are kept and it can be resumed later by sending it a new instruction.',
      inputSchema: z.object({ session: sessionRef }),
      execute: async ({ session }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const r = await m.stop(f.session.id)
        return r.ok ? { status: 'stopped', session: f.session.name } : { status: 'failed', error: r.error }
      }
    }),

    claude_reset: tool({
      description: 'Fresh start for a session: stop it and forget its conversation so the next instruction begins a new one. Its folder and files are kept. Use for "start over", "restart it", "clear its memory".',
      inputSchema: z.object({ session: sessionRef }),
      execute: async ({ session }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const r = await m.reset(f.session.id)
        return r.ok ? { status: 'fresh start', session: f.session.name } : { status: 'failed', error: r.error }
      }
    }),

    claude_files: tool({
      description: "The files in a session's workspace folder (newest first, with sizes). Use when the user asks what it made, what is in the folder, or which file changed.",
      inputSchema: z.object({ session: sessionRef }),
      execute: async ({ session }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const files = m.files(f.session.id).filter((x) => !x.dir).sort((a, b) => b.mtime - a.mtime)
        return { session: f.session.name, count: files.length, files: files.slice(0, 25).map((x) => ({ path: x.path, kb: Math.round(x.size / 102.4) / 10, modified: new Date(x.mtime).toLocaleTimeString() })) }
      }
    })
  }
}

/** A compact, always-current block for the system prompt so the voice model knows what the sessions are up to. */
export function claudeContextBlock(m: ClaudeSessionManager): string {
  const sessions = m.list()
  if (!sessions.length) return 'No Claude Code sessions yet.'
  return sessions
    .map((s) => {
      const head = `- ${s.name} [${s.status}]${s.queued.length ? `, ${s.queued.length} queued` : ''}`
      if (s.pending?.kind === 'question') {
        const q = s.pending.questions.map((x) => `${x.question} ${x.options.map((o, i) => `${i + 1}) ${o.label}`).join('  ')}`).join(' | ')
        return `${head}\n  WAITING ON THE USER (question): ${q}`
      }
      if (s.pending) return `${head}\n  WAITING ON THE USER (approval): ${s.pending.summary}`
      return `${head}${s.lastSummary ? ` — ${s.lastSummary.slice(0, 140)}` : ''}`
    })
    .join('\n')
}
