// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { single } from './single'

describe('single', () => {
  it('a second subscribe under the same key (a hot-reloaded module) removes the first listener', () => {
    const offA = vi.fn()
    const offB = vi.fn()
    single('k', () => offA)
    const release = single('k', () => offB)
    expect(offA).toHaveBeenCalledTimes(1)
    expect(offB).not.toHaveBeenCalled()
    release()
    expect(offB).toHaveBeenCalledTimes(1)
    single('k', () => vi.fn())
    expect(offB).toHaveBeenCalledTimes(1) // released ones are not called again
  })
})
