import { describe, expect, it } from 'vitest'
import { hasTags, stripTags } from './tags'

describe('stripTags', () => {
  it('removes bracket and parenthesis cues and tidies the spacing around them', () => {
    expect(stripTags('[laughs] That went well, honestly.')).toBe('That went well, honestly.')
    expect(stripTags('Well (sighing) , that is that.')).toBe('Well, that is that.')
    expect(stripTags('Right [clear throat] so. [whispers] Quietly now.')).toBe('Right so. Quietly now.')
  })

  it('keeps real asides, numbers and the app’s own interruption notes', () => {
    expect(stripTags('The total (about 40 pounds) is fine.')).toBe('The total (about 40 pounds) is fine.')
    expect(stripTags('See section [3] and (B).')).toBe('See section [3] and (B).')
    expect(stripTags('I was [interrupted here; the user heard up to this point]')).toBe('I was [interrupted here; the user heard up to this point]')
  })

  it('returns an empty string for a sentence that was only a cue', () => {
    expect(stripTags('[laughs]')).toBe('')
    expect(hasTags('[laughs]')).toBe(true)
    expect(hasTags('No cue here.')).toBe(false)
  })
})
