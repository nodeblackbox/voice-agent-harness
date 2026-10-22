/** Streaming input + interrupt + resume. Question: after interrupt() is the session still usable and resumable? */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { MODEL, describe, finding, freshWorkspace, inputStream, log } from './_common'

const cwd = freshWorkspace('01-interrupt')
const input = inputStream()
const q = query({
  prompt: input as never,
  options: { cwd, model: MODEL, settingSources: [], permissionMode: 'acceptEdits', allowedTools: ['Bash', 'PowerShell', 'Write'], maxTurns: 6 },
})

let sid = ''
let interrupted = false
let results = 0
input.push('Run the shell command `ping -n 25 127.0.0.1` and then tell me it finished.')

const timer = setTimeout(async () => {
  log('>> calling interrupt()')
  const receipt = await q.interrupt()
  interrupted = true
  log('<< interrupt resolved', JSON.stringify(receipt))
}, 12000)

for await (const m of q as AsyncIterable<any>) {
  log(describe(m))
  if (m.type === 'system' && m.subtype === 'init') sid = m.session_id
  if (m.type === 'result') {
    results++
    if (results === 1) {
      clearTimeout(timer)
      finding('interrupt', `first result after interrupt=${interrupted}: subtype=${m.subtype} terminal=${m.terminal_reason}`)
      // Same live query, follow-up message: does it still answer, and does it remember?
      input.push('Without running anything: what was the command I asked you to run? One sentence.', sid)
    } else {
      finding('interrupt-followup', `follow-up on same stream answered: ${String(m.result).slice(0, 120)}`)
      input.close()
    }
  }
}

// Fresh process resume by session id.
const r = query({ prompt: 'What command had I asked you to run earlier? One sentence.', options: { cwd, model: MODEL, settingSources: [], resume: sid, maxTurns: 1 } })
for await (const m of r as AsyncIterable<any>) {
  if (m.type === 'result') finding('resume-after-interrupt', `new process resume sid=${sid.slice(0, 8)}: ${String(m.result).slice(0, 120)}`)
}
