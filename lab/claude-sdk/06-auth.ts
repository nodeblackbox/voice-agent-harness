/**
 * Which credential do sessions bill? Starts the CLI exactly as the app does (same env scrub), asks for the
 * account without sending a prompt (costs nothing), and prints it. Run: pnpm lab:auth
 */
import { query } from '@anthropic-ai/claude-agent-sdk'
import { sessionEnv } from '../../src/core/claude/sdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// not from _common: that drops ANTHROPIC_API_KEY, and this test must prove the app's own scrub does it (same default folder)
const WORKSPACE = process.env.LAB_WORKSPACE ?? path.join(os.tmpdir(), 'voice-agent-lab')

async function main() {
  fs.mkdirSync(WORKSPACE, { recursive: true })
  console.log('ANTHROPIC_API_KEY in this shell:', process.env.ANTHROPIC_API_KEY ? 'set' : 'not set')
  // never yields: the CLI starts and answers control requests, but no turn (and no usage) happens
  const idle = { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } }
  // --raw skips the scrub, to show what would be billed without it
  const env = process.argv.includes('--raw') ? { ...process.env } : sessionEnv()
  const q = query({ prompt: idle as never, options: { cwd: WORKSPACE, env, settingSources: [] } })
  try {
    console.log('account:', JSON.stringify(await q.accountInfo(), null, 2))
  } finally {
    q.close()
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
