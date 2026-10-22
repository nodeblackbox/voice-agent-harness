/** The real Agent SDK behind the `CcSdk` seam. Everything else in core/claude is SDK-free and tested with a fake. */
import { getSessionMessages, listSessions, query } from '@anthropic-ai/claude-agent-sdk'
import type { CcHistory, CcSdk } from './types'

/**
 * Sessions ride the ambient `claude` login. A stale ANTHROPIC_API_KEY in the environment (the voice app's own
 * LLM keys can leak in via .env) makes the CLI answer "Invalid API key" instead, so it is stripped here.
 */
function sessionEnv(): Record<string, string | undefined> {
  return { ...process.env, ANTHROPIC_API_KEY: undefined }
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
      permissionMode: 'default',
      // Deliberately no allowedTools: a bare entry would skip canUseTool (lab finding).
      canUseTool: async (toolName, input) => o.canUseTool(toolName, input),
      hooks: {
        PreToolUse: [{
          hooks: [async (input: any) => {
            const v = o.gate(String(input.tool_name), (input.tool_input ?? {}) as Record<string, unknown>)
            if (v.allow) return {}
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: v.reason } }
          }],
        }],
      },
    },
  })
  return {
    messages: q,
    interrupt: async () => { await q.interrupt() },
    close: () => q.close(),
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
