// Delivery cues the model may write when `voice.expressive` is on: "[laughs]" (ElevenLabs, Inworld) or
// "(sighing)" (Fish). An engine that does not understand them would read them aloud, so the Speaker strips
// them before handing a sentence to such an engine.

/** A short bracketed or parenthesised run of lowercase words: a cue, not a real aside or an interruption note. */
const CUE = /(?:\[[a-z][a-z' -]{0,40}\]|\((?:[a-z][a-z' -]{0,40})\))/g

export function stripTags(text: string): string {
  return text
    .replace(CUE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim()
}

export const hasTags = (text: string): boolean => {
  CUE.lastIndex = 0
  return CUE.test(text)
}
