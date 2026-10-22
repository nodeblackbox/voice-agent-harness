/** Turn a session's recent events into a short, speakable "what just happened". Pure. */
import type { CcEvent } from './types'

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

export function digest(events: CcEvent[], maxChars = 280): string {
  if (!events.length) return 'Nothing has happened yet.'
  // Only the latest turn: from the last user message on.
  let from = 0
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.kind === 'user') { from = i; break }
  const turn = events.slice(from)

  const tools = new Map<string, number>()
  let denied = 0
  let lastText = ''
  let result = ''
  let error = ''
  let interrupted = false
  for (const e of turn) {
    if (e.kind === 'tool') { const name = e.text.split(' ')[0] ?? 'tool'; tools.set(name, (tools.get(name) ?? 0) + 1) }
    else if (e.kind === 'denied') denied++
    else if (e.kind === 'text') lastText = e.text
    else if (e.kind === 'result') result = e.text
    else if (e.kind === 'error') error = e.text
    else if (e.kind === 'interrupt') interrupted = true
  }

  const parts: string[] = []
  if (tools.size) parts.push('Used ' + [...tools].map(([n, c]) => (c > 1 ? `${n} ${c} times` : n)).join(', ') + '.')
  if (denied) parts.push(`${denied} action${denied > 1 ? 's were' : ' was'} blocked.`)
  if (interrupted) parts.push('It was interrupted.')
  if (error) parts.push(`Error: ${error}`)
  const said = result || lastText
  if (said) parts.push(said)
  return clip(parts.join(' ') || 'Working on it.', maxChars)
}
