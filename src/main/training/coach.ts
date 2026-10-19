// Reads the recording coach's spoken labels ("Free talk.", "Guided line. Say this: \"...\"",
// "Emotion, surprised. ...", or the bracket form "[emotion: surprised]") out of its reply text.

export interface CoachTags {
  category: string | null
  delivery: string | null
  target_text: string | null
  retake: boolean
}

const LABEL = /^\s*\[?\s*(free(?:[ -]?talk)?|guided(?:[ -]?line)?|emotion|tech)\b(?:\s*[:,\-–]\s*([a-z]+(?: out loud)?))?/i
const CATEGORY: Record<string, string> = { free: 'free_talk', guided: 'guided', emotion: 'emotion', tech: 'tech' }

export function parseCoachText(text: string): CoachTags {
  const retake = /^\W*go again\b/i.test(text)
  const body = retake ? text.replace(/^\W*go again\W*/i, '') : text
  const m = LABEL.exec(body)
  const kind = m ? m[1]!.toLowerCase().split(/[ -]/)[0]!.replace(/talk|line/, '') : null
  const delivery = kind === 'emotion' && m?.[2] ? m[2].toLowerCase().replace(/\s+/g, '_') : null
  const category = kind ? (kind === 'emotion' && delivery ? `emotion_${delivery}` : CATEGORY[kind] ?? null) : null
  return { category, delivery, target_text: targetText(body), retake }
}

function targetText(text: string): string | null {
  const at = /\bsay (?:this|it)\b[:,]?\s*/i.exec(text)
  if (!at) return null
  const rest = text.slice(at.index + at[0].length)
  const quoted = /["“]([^"”]+)["”]/.exec(rest)
  if (quoted) return quoted[1]!.trim()
  const plain = rest.split(/\s+(?:then|now) (?:say|try|do|go)\b/i)[0]!.trim()
  return plain || null
}
