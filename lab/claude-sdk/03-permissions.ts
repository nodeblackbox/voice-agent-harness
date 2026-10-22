/** Which gate actually fires: canUseTool (default mode), a PreToolUse deny hook, or disallowedTools? */
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { MODEL, finding, freshWorkspace, log } from './_common'

async function run(label: string, extra: Record<string, unknown>) {
  const cwd = freshWorkspace('03-' + label)
  const calls: string[] = []
  const q = query({
    prompt: 'Run the shell command `echo gate-test > proof.txt` and report whether it worked.',
    options: {
      cwd, model: MODEL, settingSources: [], maxTurns: 4,
      canUseTool: async (name, input) => { calls.push(`canUseTool:${name}`); return { behavior: 'deny', message: 'denied by canUseTool' } },
      ...extra,
    } as never,
  })
  for await (const m of q as AsyncIterable<any>) if (m.type === 'result') break
  const ran = fs.existsSync(path.join(cwd, 'proof.txt'))
  finding('perm-' + label, `command executed=${ran}; callbacks=[${calls.join(', ')}]`)
}

await run('default-mode', { permissionMode: 'default' })
await run('default-allowedTools', { permissionMode: 'default', allowedTools: ['Bash', 'PowerShell'] })
await run('disallowedTools', { permissionMode: 'default', disallowedTools: ['Bash', 'PowerShell'] })
await run('pretooluse-deny-hook', {
  permissionMode: 'default',
  allowedTools: ['Bash', 'PowerShell'],
  hooks: { PreToolUse: [{ matcher: 'Bash|PowerShell', hooks: [async () => {
    log('hook fired')
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'blocked by hook' } }
  }] }] },
})
