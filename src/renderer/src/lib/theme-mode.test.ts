import { beforeEach, describe, expect, it } from 'vitest'
import { THEME_KEY, applyTheme, readStoredTheme, resolveTheme } from './theme-mode'

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('theme mode', () => {
  it('resolves system to whatever the OS says, and a fixed choice to itself', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('applies the theme to <html> and remembers it for the next launch', () => {
    applyTheme('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    expect(readStoredTheme()).toBe('light')
    applyTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('treats anything unknown in storage as dark', () => {
    localStorage.setItem(THEME_KEY, 'neon')
    expect(readStoredTheme()).toBe('dark')
  })
})
