import { describe, expect, it } from 'vitest'
import { parseRange } from './range'

describe('parseRange', () => {
  it('reads open, closed and suffix ranges, clamped to the file', () => {
    expect(parseRange('bytes=0-', 1000)).toEqual({ start: 0, end: 999 })
    expect(parseRange('bytes=100-199', 1000)).toEqual({ start: 100, end: 199 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-200', 1000)).toEqual({ start: 800, end: 999 })
  })

  it('sends the whole file for no header or multi-range, and refuses ranges past the end', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull()
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=5-2', 1000)).toBe('unsatisfiable')
  })
})
