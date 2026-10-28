/**
 * Permission modes: does plan mode hand the plan to canUseTool (ExitPlanMode), can the mode change mid-stream
 * (setPermissionMode), and does the PreToolUse hook's `cwd` follow the shell's `cd`?
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import fs from 'node:fs'
import path from 'node:path'
import { MODEL, describe, finding, freshWorkspace, inputStream, log } from './_common'

async function plan() {
  const cwd = freshWorkspace('07-plan')
  const input = inputStream()
  const calls: string[] = []
  let planText = ''
  const q = query({
    prompt: input as never,
    options: {
      cwd, model: MODEL, settingSources: [], permissionMode: 'plan',
      canUseTool: async (name, inp) => {
        calls.push(`${name}(${Object.keys(inp).join(',')})`)
        if (name === 'ExitPlanMode') {
          planText = String((inp as any).plan ?? '')
          await q.setPermissionMode('acceptEdits')
          return { behavior: 'allow', updatedInput: inp }
        }
        return { behavior: 'allow', updatedInput: inp }
      },
    },
  })
  input.push('Create notes.md containing the single line "planned". Keep the plan to two lines.')
  for await (const m of q as AsyncIterable<any>) {
    log(describe(m))
    if (m.type === 'result') break
  }
  input.close()
  q.close()
  const made = fs.existsSync(path.join(cwd, 'notes.md'))
  finding('plan-mode', `canUseTool=[${calls.join(', ')}]; plan chars=${planText.length} (${JSON.stringify(planText.slice(0, 80))}); file created after approve+setPermissionMode(acceptEdits)=${made}`)
}

async function hookCwd() {
  const cwd = freshWorkspace('07-cwd')
  const seen: string[] = []
  const q = query({
    prompt: 'Run these as TWO separate shell tool calls, in order: first `mkdir sub; cd sub`, then `echo here > where.txt`. Then stop.',
    options: {
      cwd, model: MODEL, settingSources: [], permissionMode: 'default', maxTurns: 6,
      canUseTool: async (_n, inp) => ({ behavior: 'allow', updatedInput: inp }),
      hooks: { PreToolUse: [{ hooks: [async (i: any) => { seen.push(`${i.tool_name}@${path.relative(cwd, i.cwd) || '.'}`); return {} }] }] },
    },
  })
  for await (const m of q as AsyncIterable<any>) if (m.type === 'result') break
  const inSub = fs.existsSync(path.join(cwd, 'sub', 'where.txt'))
  finding('hook-cwd', `hook cwd per call=[${seen.join(', ')}]; second command ran in sub=${inSub}`)
}

const which = process.argv[2]
if (!which || which === 'plan') await plan()
if (!which || which === 'cwd') await hookCwd()

/** A PreToolUse hook that answers 'ask' (instead of deny): does it reach canUseTool, with the reason? */
async function hookAsk() {
  const cwd = freshWorkspace('07-ask')
  const calls: string[] = []
  const q = query({
    prompt: 'Run the shell command `echo asked > asked.txt`, then a second command `echo second > second.txt`. Report both.',
    options: {
      cwd, model: MODEL, settingSources: [], permissionMode: 'default', maxTurns: 6,
      canUseTool: async (name, inp, o: any) => {
        calls.push(`${name} reason=${JSON.stringify(o.decisionReason ?? null)} id=${o.toolUseID ? 'yes' : 'no'}`)
        const allow = String((inp as any).command ?? '').includes('asked')
        return allow ? { behavior: 'allow', updatedInput: inp } : { behavior: 'deny', message: 'user said no' }
      },
      hooks: { PreToolUse: [{ hooks: [async (i: any) => (i.tool_name === 'Bash' || i.tool_name === 'PowerShell')
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'fence: outside the folder' } }
        : {}] }] },
    },
  })
  for await (const m of q as AsyncIterable<any>) if (m.type === 'result') break
  finding('hook-ask', `canUseTool calls=[${calls.join(' | ')}]; asked.txt=${fs.existsSync(path.join(cwd, 'asked.txt'))} second.txt=${fs.existsSync(path.join(cwd, 'second.txt'))}`)
}
if (which === 'ask') await hookAsk()
