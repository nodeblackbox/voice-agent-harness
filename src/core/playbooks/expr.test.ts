import { describe, expect, it } from 'vitest'
import { compile, ExprError } from './expr'

const ctx = { text: 'Please push the changes', chars: 1834, via: 'voice', fromSplit: false, tuning: { longMessageChars: 1200 }, tags: ['a', 'b'] }

describe('playbook expressions', () => {
  it('compares numbers, reads dotted names and combines with and/or/not', () => {
    expect(compile('chars > tuning.longMessageChars and not fromSplit').test(ctx)).toBe(true)
    expect(compile('chars <= 100 or via == "typed"').test(ctx)).toBe(false)
    expect(compile('(chars - 834) / 2 == 500').test(ctx)).toBe(true)
    expect(compile('chars % 10 == 4 and chars % 0 == null').test(ctx)).toBe(true)
  })

  it('treats missing data as empty, never as an error', () => {
    expect(compile('missing > 3').test(ctx)).toBe(false)
    expect(compile('missing == null').test(ctx)).toBe(true)
    expect(compile('tuning.nothing.deeper > 0').test(ctx)).toBe(false)
    expect(compile('len(missing) > 0').test(ctx)).toBe(false)
  })

  it('cannot reach prototypes or functions', () => {
    expect(compile('text.length > 0').test(ctx)).toBe(false)
    expect(compile('constructor == null').test(ctx)).toBe(true)
    expect(compile('tuning.__proto__ == null').test(ctx)).toBe(true)
  })

  it('has the string helpers, case-insensitive', () => {
    expect(compile('has(text, "PUSH")').test(ctx)).toBe(true)
    expect(compile('any_of(text, ["deploy", "changes"])').test(ctx)).toBe(true)
    expect(compile('"push" in text').test(ctx)).toBe(true)
    expect(compile('"c" in tags').test(ctx)).toBe(false)
    expect(compile('lower(via) == "voice" and max(1, chars, 5) == 1834').test(ctx)).toBe(true)
  })

  it('lists the names it reads', () => {
    expect(compile('chars > tuning.longMessageChars and has(text, "x")').names.sort()).toEqual(['chars', 'text', 'tuning.longMessageChars'])
  })

  it('reports syntax errors with a column', () => {
    expect(() => compile('chars >')).toThrow(ExprError)
    expect(() => compile('eval("x")')).toThrow(/unknown function "eval"/)
    try {
      compile('chars > 1 1')
    } catch (e) {
      expect((e as ExprError).column).toBe(11)
    }
    expect(() => compile('"open')).toThrow(/quote/)
  })
})
