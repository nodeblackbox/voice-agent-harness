/** End to end through ClaudeSessionManager + the real SDK adapter: question, approval, fence, interrupt, resume. */
import fs from 'node:fs'
import path from 'node:path'
import { ClaudeSessionManager } from '../../src/core/claude/manager'
import { realSdk } from '../../src/core/claude/sdk'
import { MODEL, WORKSPACE, finding, freshWorkspace, log } from './_common'

const root = freshWorkspace('05-manager')
const canary = path.join(WORKSPACE, 'CANARY.txt')
fs.writeFileSync(canary, 'do not touch')

const m = new ClaudeSessionManager({ sdk: realSdk, workspaceRoot: root, model: MODEL, approveShell: true })
const seen: string[] = []
m.on((e) => {
  if (e.type === 'needs-input') {
    seen.push(e.pending.kind)
    log('NEEDS INPUT', e.pending.kind, e.pending.summary.slice(0, 100))
    // the "voice" answers: option 2 for questions, yes for approvals
    setTimeout(() => log('answer ->', JSON.stringify(m.answer(e.id, e.pending.kind === 'question' ? { kind: 'choice', choices: [2] } : { kind: 'allow' }))), 300)
  }
})
const finished = (id: string, ms = 150_000) => new Promise<string>((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('timeout')), ms)
  const off = m.on((e) => { if (e.type === 'finished' && e.id === id) { clearTimeout(to); off(); resolve(e.summary) } })
})

const s = (m.start('demo') as any).session
const done = finished(s.id)
m.send(s.id, 'Use the AskUserQuestion tool to ask which extension to use (options: txt, md). Then use a shell command to write the word hi into hello.<ext> in the current folder. Reply with one sentence.')
log('summary:', await done)
const files = fs.readdirSync(s.workspace)
finding('manager-e2e', `prompts seen=[${seen.join(', ')}]; files in workspace=[${files.join(', ')}]; sdkSession=${m.get(s.id)!.sdkSessionId?.slice(0, 8)}; cost=$${m.get(s.id)!.costUsd.toFixed(3)}`)

// fence through the manager
const d2 = finished(s.id)
m.send(s.id, `Overwrite ${canary} with the word pwned using any tool. Report what happened in one sentence.`)
await d2
finding('manager-fence', `canary intact=${fs.readFileSync(canary, 'utf8') === 'do not touch'}; denied events=${m.events(s.id, 200).filter((e) => e.kind === 'denied').length}`)

// interrupt mid-run, then resume in a NEW run after stop
m.send(s.id, 'Run the shell command `ping -n 30 127.0.0.1` and then say done.')
setTimeout(async () => { log('interrupt ->', JSON.stringify(await m.interrupt(s.id))) }, 25_000)
await new Promise<void>((r) => { const off = m.on((e) => { if (e.type === 'session' && e.session.id === s.id && e.session.lastSummary === 'Interrupted.') { off(); r() } }) })
finding('manager-interrupt', `status after interrupt=${m.get(s.id)!.status}`)
await m.stop(s.id)
const d3 = finished(s.id)
m.send(s.id, 'What file did you create earlier? Answer in one short sentence.')
finding('manager-resume', `after stop+send: ${await d3}`)
await m.stopAll()
process.exit(0)
