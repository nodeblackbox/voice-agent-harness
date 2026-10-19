import { describe, expect, it } from 'vitest'
import { parseCoachText } from './coach'

describe('parseCoachText', () => {
  it('reads the spoken labels the coach starts each prompt with', () => {
    expect(parseCoachText('Free talk. What properly annoyed you this week?')).toEqual({ category: 'free_talk', delivery: null, target_text: null, retake: false })
    expect(parseCoachText('Emotion, surprised. Your mate just texted you that...')).toMatchObject({ category: 'emotion_surprised', delivery: 'surprised' })
    expect(parseCoachText('Emotion, thinking out loud. You can only pick one...')).toMatchObject({ category: 'emotion_thinking_out_loud', delivery: 'thinking_out_loud' })
    expect(parseCoachText('Nice one. Anyway, what did you eat today?')).toMatchObject({ category: null, delivery: null })
  })

  it('accepts the bracket form too', () => {
    expect(parseCoachText('[emotion: annoyed] It crashed again.')).toMatchObject({ category: 'emotion_annoyed', delivery: 'annoyed' })
    expect(parseCoachText('[guided] Say this: "Three things, then I\'m done."')).toMatchObject({ category: 'guided', target_text: "Three things, then I'm done." })
  })

  it('pulls the target line out of a guided prompt, quoted or not', () => {
    expect(parseCoachText('Guided line. Say this: “Can\'t be asked, I\'m having a bath.” Then say it your own way.').target_text).toBe("Can't be asked, I'm having a bath.")
    expect(parseCoachText('Guided line. Say this: Latency dropped to four hundred milliseconds. Then say it your own way.').target_text).toBe('Latency dropped to four hundred milliseconds.')
  })

  it('spots a retake and still reads the repeated prompt', () => {
    expect(parseCoachText('Go again. Guided line. Say this: "Nah, listen."')).toEqual({ category: 'guided', delivery: null, target_text: 'Nah, listen.', retake: true })
  })
})
