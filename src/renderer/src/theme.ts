import type { AgentState, ServiceState, ToolStatus } from '@shared/types'

/**
 * Design tokens. Every colour is a CSS variable defined in index.css: dark values on :root, light values under
 * [data-theme="light"]. Components read T.x as before; the theme switches by changing one attribute on <html>.
 * Use alpha(T.x, pct) for a transparent tint of a token (never append hex digits to a token: it is a var() now).
 */
export const T = {
  bg: 'var(--va-bg)',
  rail: 'var(--va-rail)',
  surface: 'var(--va-surface)',
  raised: 'var(--va-raised)',
  border: 'var(--va-border)',
  text: 'var(--va-text)',
  text2: 'var(--va-text2)',
  text3: 'var(--va-text3)',
  cyan: 'var(--va-cyan)',
  violet: 'var(--va-violet)',
  green: 'var(--va-green)',
  amber: 'var(--va-amber)',
  red: 'var(--va-red)',
  cyanTint: 'var(--va-cyan-tint)',
  cyanBorder: 'var(--va-cyan-border)',
  violetTint: 'var(--va-violet-tint)',
  violetBorder: 'var(--va-violet-border)',
  amberTint: 'var(--va-amber-tint)',
  redTint: 'var(--va-red-tint)',
  greenTint: 'var(--va-green-tint)',
  wash: 'var(--va-wash)',
  washSoft: 'var(--va-wash-soft)',
  shadow: 'var(--va-shadow)',
  shimmer: 'var(--va-shimmer)',
  scrollbar: 'var(--va-scrollbar)',
  treeGuide: 'var(--va-tree-guide)',
  borderStrong: 'var(--va-border-strong)',
  borderStronger: 'var(--va-border-stronger)',
  claude: 'var(--va-claude)',
  claudeText: 'var(--va-claude-text)',
  steel: 'var(--va-steel)',
  bypass: 'var(--va-bypass)',
  mono: "ui-monospace, 'SF Mono', Menlo, monospace"
} as const

/** A colour at pct% opacity, e.g. alpha(T.cyan, 10) for a 10% cyan tint. Works for var() tokens and literals alike. */
export const alpha = (color: string, pct: number): string => `color-mix(in srgb, ${color} ${pct}%, transparent)`

/** Terminal and code panels stay dark in both themes, like an embedded terminal. */
export const TERM = {
  bg: '#07080a',
  chrome: '#0c0e11',
  border: '#15181c',
  text: '#C9D1D9',
  bright: '#E6EDF3',
  dim: '#9aa4af',
  diff: '#D5DCE3',
  dimDiff: '#7d858f',
  gutter: '#3a4049',
  err: '#ff9b9b',
  minus: 'rgba(255,107,107,.10)',
  plus: 'rgba(74,222,128,.09)'
} as const

/** The media stage (pictures, video, audio) is a dark surface in both themes. */
export const MEDIA = {
  stage: '#050607',
  scrim: 'rgba(5,6,7,.75)'
} as const

export const serviceColor = (s: ServiceState | undefined): string => {
  switch (s) {
    case 'ready':
      return T.green
    case 'starting':
    case 'reconnecting':
      return T.amber
    case 'error':
      return T.red
    default:
      return T.text3
  }
}

export const serviceLabel = (s: ServiceState | undefined): string => {
  switch (s) {
    case 'ready':
      return 'ready'
    case 'starting':
      return 'starting'
    case 'reconnecting':
      return 'reconnecting'
    case 'error':
      return 'error'
    default:
      return 'off'
  }
}

export const agentStateColor = (s: AgentState): string => {
  switch (s) {
    case 'listening':
    case 'user_speaking':
    case 'speaking':
      return T.cyan
    case 'thinking':
    case 'tool':
      return T.violet
    case 'interrupted':
      return T.amber
    default:
      return T.text3
  }
}

export const toolStatusColor = (s: ToolStatus): string => {
  switch (s) {
    case 'running':
    case 'done':
      return T.violet
    case 'error':
      return T.amber
    default:
      return T.text3
  }
}
