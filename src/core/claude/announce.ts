/** Turn a manager event into a line the voice agent says unprompted, or null when it should stay quiet. Pure. */
import type { CcManagerEvent } from './types'

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Why the fence asked, in a few spoken words (the exact path is on screen). */
function spokenReason(reason: string): string {
  if (/deletes outside/i.test(reason)) return 'That deletes something outside its folder.'
  if (/deletes files/i.test(reason)) return 'That deletes files.'
  if (/risky command/i.test(reason)) return 'That one is risky.'
  if (/outside its folder/i.test(reason)) return 'That is outside its folder.'
  return ''
}

export function announcement(e: CcManagerEvent): string | null {
  if (e.type === 'needs-input') {
    const p = e.pending
    if (p.kind === 'plan') {
      // only the headline: the full plan is on screen, and claude_details reads it out when asked
      return `${e.name} has a plan ready: ${clip(oneLine(p.summary), 140)}. Shall it go ahead, or do you want changes?`
    }
    if (p.kind === 'permission') {
      const why = p.reason ? ` ${spokenReason(p.reason)}` : ''
      return `${e.name} wants to ${clip(oneLine(p.summary.replace(/^Run:\s*/i, 'run: ')), 140)}.${why} Is that okay?`
    }
    const q = p.questions[0]
    if (!q) return null
    const opts = q.options.slice(0, 4).map((o, i) => `${i + 1}, ${clip(oneLine(o.label), 40)}`).join('. ')
    const more = p.questions.length > 1 ? ` There ${p.questions.length - 1 === 1 ? 'is one more question' : `are ${p.questions.length - 1} more questions`} after this.` : ''
    return `${e.name} has a question. ${clip(oneLine(q.question), 160)} ${opts}.${more}`
  }
  if (e.type === 'finished') {
    const s = oneLine(e.summary)
    return s ? `${e.name} is done. ${clip(s, 220)}` : `${e.name} is done.`
  }
  return null
}
