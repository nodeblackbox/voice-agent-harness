/** The real Agent SDK behind the `CcSdk` seam. Everything else in core/claude is SDK-free and tested with a fake. */
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import type { CcAccount } from '@shared/claude'
import { toAccount } from './account'
import { FENCE_TAG, type CcHistory, type CcSdk } from './types'

/**
 * Anything here would make the CLI bill an API key or another provider instead of the user's `claude` login
 * (their subscription). ANTHROPIC_API_KEY is set on this machine for the voice app's own LLM, so it would
 * otherwise win.
 */
const NOT_THE_LOGIN = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
]

/** Sessions always ride the user's `claude` login (subscription), never the voice app's API key. */
export function sessionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  for (const k of NOT_THE_LOGIN) env[k] = undefined
  return env
}

export const realSdk: CcSdk = (o) => {
  const q = query({
    prompt: o.input as never,
    options: {
      cwd: o.cwd,
      model: o.model,
      resume: o.resume,
      forkSession: o.fork || undefined,
      env: sessionEnv(),
      settingSources: [], // no user/project settings or CLAUDE.md from the host machine
      permissionMode: o.permissionMode,
      // Deliberately no allowedTools: a bare entry would skip canUseTool (lab finding).
      canUseTool: async (toolName, input, opts) => o.canUseTool(toolName, input, { reason: opts.decisionReason }),
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            // input.cwd follows the shell's `cd` (lab 07), so relative paths resolve where they will run
            const v = o.gate(String(input.tool_name), (input.tool_input ?? {}) as Record<string, unknown>, typeof input.cwd === 'string' ? input.cwd : undefined)
            if (v.allow) return {}
            // 'ask' reaches canUseTool with this reason (lab 07), where it becomes a spoken approval
            const decision = v.ask ? ('ask' as const) : ('deny' as const)
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: decision, permissionDecisionReason: v.ask ? FENCE_TAG + v.reason : v.reason } }
          }],
        }],
      },
    },
  })
  return {
    messages: q,
    interrupt: async () => { await q.interrupt() },
    setPermissionMode: (mode) => q.setPermissionMode(mode),
    close: () => q.close(),
  }
}

/**
 * Ask the CLI who it runs as, started exactly like a session (same env scrub). The prompt never yields, so no
 * turn runs and nothing is used; the process is closed once it answers.
 */
export async function realAccount(cwd: string, timeoutMs = 30_000): Promise<CcAccount> {
  const idle = { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } }
  const q = query({ prompt: idle as never, options: { cwd, env: sessionEnv(), settingSources: [] } })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const late = new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('Claude Code did not answer in time.')), timeoutMs) })
    return toAccount(await Promise.race([q.accountInfo(), late]))
  } catch (e) {
    return { billing: 'unknown', error: e instanceof Error ? e.message : String(e) }
  } finally {
    clearTimeout(timer)
    q.close()
  }
}

export const realHistory: CcHistory = {
  async list(limit) {
    // interactive sessions only (like the CLI's /resume), not programmatic ones such as our own
    const all = await listSessions({ limit, includeProgrammatic: false })
    return all
      .filter((s) => !!s.cwd)
      .map((s) => ({
        sessionId: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || 'Untitled', cwd: s.cwd!, branch: s.gitBranch,
        lastModified: s.lastModified, createdAt: s.createdAt, size: s.fileSize,
      }))
  },
  messages: (sessionId, cwd) => getSessionMessages(sessionId, { dir: cwd }),
}
