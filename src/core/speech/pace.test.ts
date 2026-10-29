import { describe, expect, it } from 'vitest'
import { DEFAULT_TUNING } from '@shared/tuning'
import { LatencyEstimate, firstChunkWords } from './pace'

const speech = { ...DEFAULT_TUNING.speech, firstMinWords: 4 }

describe('firstChunkWords', () => {
  it('keeps the setting for a quick engine or before any measurement', () => {
    expect(firstChunkWords(speech, undefined)).toBe(4)
    expect(firstChunkWords(speech, 180)).toBe(4)
    expect(firstChunkWords(speech, 500)).toBe(4)
  })

  it('grows the first chunk so it keeps playing while a slow engine renders the next one', () => {
    expect(firstChunkWords(speech, 800)).toBe(4)
    expect(firstChunkWords(speech, 2400)).toBe(7)
    expect(firstChunkWords(speech, 9000)).toBe(15)
  })

  it('stays off when the early cut is disabled', () => {
    expect(firstChunkWords({ ...speech, firstMinWords: 0 }, 3000)).toBe(0)
  })
})

describe('LatencyEstimate', () => {
  it('takes the first sample as is and then smooths', () => {
    const l = new LatencyEstimate()
    expect(l.get('fish')).toBeUndefined()
    l.sample('fish', 2000)
    expect(l.get('fish')).toBe(2000)
    l.sample('fish', 1000)
    expect(l.get('fish')).toBe(1600)
    expect(l.get('edge')).toBeUndefined()
  })
})
