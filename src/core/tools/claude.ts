import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { CC_MODES, type CcMode } from '@shared/claude'
import type { ClaudeSessionManager } from '../claude/manager'
import type { CcEvent, CcPending, CcSession } from '../claude/types'

const sessionRef = z.string().default('').describe('Session name (or part of it). Leave empty when there is only one session.')
const modeEnum = z.enum(CC_MODES as [CcMode, ...CcMode[]])
const isAll = (ref: string | undefined) => /^(all|every(one|thing| session)?|all sessions)$/i.test((ref ?? '').trim())
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const stepCount = (plan: string) => plan.split(/\r?\n/).filter((l) => /^\s*(\d+[.)]|[-*])\s/.test(l)).length

/** What a session is waiting on, kept short: a plan is its headline only (claude_details reads the rest). */
function waiting(p: CcPending | undefined) {
  if (!p) return null
  if (p.kind === 'question') {
    return { type: 'question', questions: p.questions.map((q) => ({ question: q.question, options: q.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` (${clip(o.description, 80)})` : ''}`), multi_select: q.multiSelect })) }
  }
  if (p.kind === 'plan') return { type: 'plan', headline: p.summary, steps: stepCount(p.plan), full_plan: 'claude_details what=plan' }
  return { type: 'approval', what: clip(p.summary, 200), ...(p.reason ? { why: p.reason } : {}) }
}

/** What the voice model is told about a session: short, speakable, no internals. */
function brief(s: CcSession, m: ClaudeSessionManager) {
  return {
    name: s.name,
    status: s.status,
    mode: s.mode,
    workspace: s.workspace,
    waiting_for_user: waiting(s.pending),
    queued_prompts: s.queued.length,
    what_just_happened: m.digest(s.id),
    cost_usd: Number(s.costUsd.toFixed(3))
  }
}

/** One line per event for claude_details: tool calls with their target, results and errors, no file contents. */
function line(e: CcEvent): string | null {
  if (e.kind === 'tool_result') return e.isError ? `  ✗ ${clip(e.text.replace(/\s+/g, ' '), 140)}` : null
  const label = e.kind === 'tool' ? '→' : e.kind === 'text' ? 'said' : e.kind
  return `${label} ${clip(e.text.replace(/\s+/g, ' '), 180)}`
}

/**
 * Voice-callable control of Claude Code sessions. Every tool returns immediately (sessions run in the
 * background and report back through events), so the 25 s tool-stall timeout never applies.
 */
export function claudeTools(m: ClaudeSessionManager): ToolSet {
  const find = (ref: string) => m.find(ref)

  return {
    claude_list: tool({
      description: 'List the Claude Code sessions (name, status, mode, what is waiting on the user, last result in short) and the existing folders in the workspace root that a new session could reuse.',
      inputSchema: z.object({}),
      execute: async () => ({
        sessions: m.list().map((s) => ({ name: s.name, status: s.status, mode: s.mode, waiting_for_user: waiting(s.pending), queued: s.queued.length, last: clip(s.lastSummary, 160) })),
        workspace_folders: m.folders().slice(0, 20).map((f) => (f.inUse ? `${f.name} (in use)` : f.name))
      })
    }),

    claude_start: tool({
      description:
        'Start a NEW Claude Code session and optionally give it a first task; to start several at once ("spin up three sessions"), put one entry per session in "more" in the same call instead of calling this again. By default each gets a fresh sandbox folder of its own. Use "folder" when the user says where it should work: the name of an existing workspace folder (see claude_list) to continue in it, or the FULL path of one of their project folders. A project path means it works in their real files (fenced to that folder), so say that and get a clear yes first. Pick short, spoken-friendly names (e.g. "landing page"). Set mode only when the user asks for one (e.g. "plan it first" = plan); otherwise leave it empty for the default.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Short session name'),
        task: z.string().default('').describe('The first instruction for Claude Code. Full, self-contained, written as a clear brief.'),
        folder: z.string().default('').describe('Optional: an existing workspace folder name, or a full project path. Empty = a new sandbox folder.'),
        mode: z.union([modeEnum, z.literal('')]).default('').describe('Optional: plan | ask | auto | bypass, for every session started in this call. Empty = the default mode.'),
        more: z
          .array(z.object({ name: z.string().min(1), task: z.string().default(''), folder: z.string().default('') }))
          .default([])
          .describe('Further sessions to start in the same go, each with its own name, task and optional folder.')
      }),
      execute: async ({ name, task, folder, mode, more }) => {
        const results = [{ name, task, folder }, ...(more ?? [])].map((s) => {
          const r = m.start(s.name, s.task || undefined, { folder: s.folder || undefined, mode: mode || undefined })
          return r.ok ? { status: 'started', session: brief(r.session, m) } : { status: 'failed', name: s.name, error: r.error }
        })
        return results.length === 1 ? results[0] : { started: results.filter((r) => r.status === 'started').length, results }
      }
    }),

    claude_send: tool({
      description:
        'Give an existing session another instruction. A stopped session (e.g. after the app restarted) wakes up and picks up its conversation where it left off. If it is busy the instruction is queued behind the current work (stacked prompts). session "all" sends the same instruction to every session ("all of you, carry on"). Set mode "now" only when the user wants to stop what it is doing and switch to this instead.',
      inputSchema: z.object({
        session: sessionRef.describe('Session name (or part of it), or "all" for every session. Leave empty when there is only one session.'),
        prompt: z.string().min(1).describe('The instruction, self-contained'),
        mode: z.enum(['queue', 'now']).default('queue')
      }),
      execute: async ({ session, prompt, mode }) => {
        const sendTo = (s: CcSession) => {
          const r = m.send(s.id, prompt, { now: mode === 'now' })
          return r.ok ? { status: r.queued ? 'queued' : mode === 'now' ? 'redirecting' : 'sent', session: s.name } : { status: 'failed', session: s.name, error: r.error }
        }
        if (isAll(session)) {
          const all = m.list()
          return all.length ? { results: all.map(sendTo) } : { status: 'failed', error: 'There are no sessions.' }
        }
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        return sendTo(f.session)
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
        'Answer what a session is waiting on. A multiple-choice question: the option number(s) ("choice") or free text ("text"). A yes/no approval: approve true or false. A plan: approve true to let it build (optionally "mode" to build in, e.g. auto), or approve false with "text" = the changes the user wants (it revises the plan). "mode" with an approval also switches the session from now on (e.g. "yes, and stop asking me" = approve true, mode auto). Only call this when the user has actually answered; never guess an answer on their behalf.',
      inputSchema: z.object({
        session: sessionRef,
        choice: z.array(z.number().int().min(1)).optional().describe('1-based option number(s); several only for multi-select; one per question when there are several questions'),
        text: z.string().optional().describe('A free-text answer instead of an option; for a plan, the changes the user wants'),
        approve: z.boolean().optional().describe('For approvals and plans: true = allow / go ahead, false = deny / send back'),
        mode: modeEnum.optional().describe('With approve true: the mode to continue in (plans: the mode to build in)')
      }),
      execute: async ({ session, choice, text, approve, mode }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const a = approve !== undefined
          ? (approve ? ({ kind: 'allow', mode } as const) : ({ kind: 'deny', reason: text } as const))
          : choice?.length ? ({ kind: 'choice', choices: choice } as const) : text ? ({ kind: 'text', text } as const) : null
        if (!a) return { status: 'failed', error: 'No answer was given.' }
        const r = m.answer(f.session.id, a)
        return r.ok ? { status: 'answered', session: f.session.name, answer: r.said } : { status: 'failed', error: r.error }
      }
    }),

    claude_mode: tool({
      description:
        'Change how much a session may do on its own. plan = it only looks around and writes a plan, nothing changes until the user approves it. ask = every shell command asks first. auto = no questions for work inside its folder (going outside it, deleting or pushing still asks). bypass = no questions at all; only when the user explicitly asks for bypass / full auto / "stop asking me anything". A waiting approval or plan that the new mode would not ask about goes ahead.',
      inputSchema: z.object({ session: sessionRef, mode: modeEnum }),
      execute: async ({ session, mode }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const r = m.setMode(f.session.id, mode)
        return r.ok ? { status: 'mode set', session: f.session.name, mode, now: r.session.status } : { status: 'failed', error: r.error }
      }
    }),

    claude_details: tool({
      description:
        'Read MORE of a session, only when the user wants specifics that the short status does not cover: what=plan for its full plan, what=answer for its whole last reply, what=activity for its recent steps one line each. Everything else stays short on purpose, to keep this conversation light.',
      inputSchema: z.object({ session: sessionRef, what: z.enum(['plan', 'answer', 'activity']) }),
      execute: async ({ session, what }) => {
        const f = find(session)
        if (!f.ok) return { status: 'failed', error: f.error }
        const s = f.session
        if (what === 'plan') {
          return s.pending?.kind === 'plan' ? { session: s.name, plan: clip(s.pending.plan, 4000) } : { session: s.name, plan: null, note: 'No plan is waiting for approval.' }
        }
        if (what === 'answer') return { session: s.name, answer: clip(s.lastSummary || 'Nothing yet.', 4000) }
        const lines = m.events(s.id, 60).map(line).filter((x): x is string => !!x).slice(-25)
        return { session: s.name, status: s.status, mode: s.mode, steps: lines }
      }
    }),

    claude_interrupt: tool({
      description: 'Stop a session mid-task without ending it ("hold on", "stop that"). It stays resumable and can be given a new instruction. session "all" stops every busy session ("stop everything"). clear_queue also drops any stacked prompts.',
      inputSchema: z.object({ session: sessionRef.describe('Session name (or part of it), or "all". Leave empty when there is only one session.'), clear_queue: z.boolean().default(false) }),
      execute: async ({ session, clear_queue }) => {
        if (isAll(session)) {
          const busy = m.list().filter((s) => s.status === 'running' || s.status === 'needs_permission' || s.status === 'needs_input')
          await Promise.all(busy.map((s) => m.interrupt(s.id, { clearQueue: clear_queue })))
          return { status: 'interrupted', sessions: busy.map((s) => s.name) }
        }
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

    claude_remove: tool({
      description:
        'Remove one or more sessions from the list for good ("get rid of slop one and slop two", "clean up the old sessions"). Stops them first. Their folders are KEPT unless delete_folder is true, which permanently deletes each one\'s sandbox folder and files; only set it when the user explicitly asked to delete the files too. Project folders of the user\'s own are never deleted.',
      inputSchema: z.object({
        sessions: z.array(z.string().min(1)).min(1).describe('Session names (or parts of names), one per session to remove'),
        delete_folder: z.boolean().default(false).describe('Also delete each session\'s sandbox folder and files (permanent)')
      }),
      execute: async ({ sessions, delete_folder }) => {
        const removed: string[] = []
        const failed: Array<{ session: string; error: string }> = []
        for (const ref of sessions) {
          const f = find(ref)
          if (!f.ok) { failed.push({ session: ref, error: f.error }); continue }
          const r = await m.remove(f.session.id, { deleteFolder: delete_folder })
          if (r.ok) removed.push(f.session.name + (r.deletedFolder ? ' (folder deleted)' : ''))
          else failed.push({ session: f.session.name, error: r.error })
        }
        return { status: failed.length ? (removed.length ? 'partly done' : 'failed') : 'removed', removed, failed, remaining: m.list().map((s) => s.name) }
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

    claude_recent: tool({
      description: "The user's OTHER Claude Code sessions on this computer (from the terminal, the IDE, other apps), newest first, with their project folder. Use when they ask about their other or earlier sessions, or want to pick one up.",
      inputSchema: z.object({ search: z.string().default('').describe('Optional words to filter titles or project folders') }),
      execute: async ({ search }) => {
        const q = search.trim().toLowerCase()
        const all = (await m.external(80)).filter((x) => !q || `${x.title} ${x.cwd}`.toLowerCase().includes(q))
        return { count: all.length, sessions: all.slice(0, 12).map((x) => ({ title: x.title, project: x.cwd, branch: x.branch, last_active: new Date(x.lastModified).toLocaleString() })) }
      }
    }),

    claude_attach: tool({
      description:
        "Continue one of the user's other saved Claude Code sessions here, so it can be steered by voice. It runs in that session's REAL project folder (not a sandbox): it can edit files there, deletes and anything outside the folder stay blocked, and every shell command asks first. The original session is left untouched (this continues a copy). Only call after the user clearly said yes to continuing that specific session.",
      inputSchema: z.object({ session: z.string().min(1).describe('Title (or part of it) of the saved session, as listed by claude_recent') }),
      execute: async ({ session }) => {
        const q = session.trim().toLowerCase()
        const all = await m.external(80)
        const hits = all.filter((x) => x.title.toLowerCase().includes(q) || x.cwd.toLowerCase().includes(q))
        if (hits.length !== 1) return { status: 'failed', error: hits.length ? `"${session}" matches ${hits.slice(0, 4).map((x) => x.title).join(', ')}` : `No saved session matching "${session}".` }
        const x = hits[0]!
        const r = await m.attach({ sessionId: x.sessionId, title: x.title, cwd: x.cwd })
        return r.ok ? { status: 'attached', session: r.session.name, project: x.cwd } : { status: 'failed', error: r.error }
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
  // newest first; long-idle sessions collapse to a name so many sessions stay cheap
  return [...sessions]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((s, i) => {
      const head = `- ${s.name} [${s.status}${s.mode ? `, ${s.mode} mode` : ''}]${s.queued.length ? `, ${s.queued.length} queued` : ''}`
      const p = s.pending
      if (p?.kind === 'question') {
        const q = p.questions.map((x) => `${x.question} ${x.options.map((o, n) => `${n + 1}) ${clip(o.label, 60)}`).join('  ')}`).join(' | ')
        return `${head}\n  WAITING ON THE USER (question): ${clip(q, 600)}`
      }
      if (p?.kind === 'plan') return `${head}\n  WAITING ON THE USER (plan to approve): ${p.summary} (${stepCount(p.plan)} steps; claude_details reads it)`
      if (p) return `${head}\n  WAITING ON THE USER (approval): ${clip(p.summary, 200)}${p.reason ? ` [${p.reason}]` : ''}`
      return `${head}${s.lastSummary && i < 6 ? ` — ${clip(s.lastSummary.replace(/\s+/g, ' '), 140)}` : ''}`
    })
    .join('\n')
}
