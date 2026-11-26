import { describe, expect, it } from 'vitest'
import { displayText, endsLine } from './spoken'
import { speakableLine } from '../../../core/prompts/speakable'

describe('reply layout', () => {
  it('draws "- " lines as bullets and drops bold stars, also when a bullet starts a new highlight span', () => {
    expect(displayText('Three things:\n- book the dentist\n- **email** the landlord', true)).toBe('Three things:\n•  book the dentist\n•  email the landlord')
    expect(displayText('- push the branch', true)).toBe('•  push the branch')
    expect(displayText('- not a bullet mid-line', false)).toBe('- not a bullet mid-line')
    expect(displayText('a - b stays', true)).toBe('a - b stays')
    // the spoken highlight starts at the item's words, so its marker ends the piece before
    expect(displayText('before January\n- ', false)).toBe('before January\n•  ')
    expect(endsLine('Three things:\n')).toBe(true)
    expect(endsLine('Three things:')).toBe(false)
  })

  it('never lets the voice say the list marker or the stars', () => {
    expect(speakableLine('- Book the dentist')).toBe('Book the dentist')
    expect(speakableLine('2. Email the **landlord**')).toBe('Email the landlord')
    expect(speakableLine('Two to three - minutes')).toBe('Two to three - minutes')
  })
})
