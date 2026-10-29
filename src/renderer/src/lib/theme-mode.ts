import type { ThemePref } from '@shared/types'

/** The theme is applied by one attribute on <html>; index.css holds both palettes. Mirrored in localStorage so the
 *  first paint already has the right colours, before settings arrive over IPC. */
export const THEME_KEY = 'va.theme'

export function readStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'system' ? v : 'dark'
  } catch {
    return 'dark'
  }
}

export function resolveTheme(pref: ThemePref, systemDark: boolean): 'dark' | 'light' {
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref
}

let watched: MediaQueryList | null = null
let onChange: (() => void) | null = null

export function applyTheme(pref: ThemePref, doc: Document = document): void {
  try {
    localStorage.setItem(THEME_KEY, pref)
  } catch {
    // storage unavailable
  }
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null
  if (watched && onChange) watched.removeEventListener('change', onChange)
  watched = null
  onChange = null
  const set = (): void => {
    doc.documentElement.dataset.theme = resolveTheme(pref, mq?.matches ?? true)
  }
  set()
  if (pref === 'system' && mq) {
    watched = mq
    onChange = set
    mq.addEventListener('change', set)
  }
}
