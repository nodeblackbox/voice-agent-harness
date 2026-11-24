/**
 * Mermaid, loaded on first use (it is large), themed from the app's own colours, and never allowed to leave
 * its error graphics on the page.
 */
import type { DiagramCheck } from '@shared/diagram'

type Mermaid = (typeof import('mermaid'))['default']

let loading: Promise<Mermaid> | null = null
let themed = ''
let counter = 0

const cssVar = (name: string, fallback: string): string => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

const themeKey = (): string => document.documentElement.dataset.theme ?? 'dark'

function configure(m: Mermaid): void {
  const key = themeKey()
  if (themed === key) return
  themed = key
  const dark = key !== 'light'
  const surface = cssVar('--va-surface', dark ? '#14171B' : '#FFFFFF')
  const raised = cssVar('--va-raised', dark ? '#1B1F24' : '#F4EEE4')
  const text = cssVar('--va-text', dark ? '#EDEEF0' : '#1E1B16')
  const text2 = cssVar('--va-text2', dark ? '#8B929B' : '#6B6458')
  const line = dark ? '#566070' : cssVar('--va-border-stronger', '#BFB3A0')
  const node = dark ? '#222830' : raised
  const cyan = cssVar('--va-cyan', dark ? '#4FD1FF' : '#0B98D6')
  const violet = cssVar('--va-violet', dark ? '#B98BFF' : '#7C4DEB')
  m.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    flowchart: { curve: 'basis', htmlLabels: true, nodeSpacing: 34, rankSpacing: 44, padding: 12 },
    sequence: { useMaxWidth: true, mirrorActors: false },
    themeVariables: {
      darkMode: dark,
      background: surface,
      primaryColor: node,
      primaryTextColor: text,
      primaryBorderColor: line,
      secondaryColor: dark ? '#1d2530' : '#EAF4FA',
      secondaryTextColor: text,
      secondaryBorderColor: line,
      tertiaryColor: surface,
      tertiaryTextColor: text,
      tertiaryBorderColor: line,
      lineColor: dark ? '#A3ACB8' : text2,
      textColor: text,
      mainBkg: node,
      nodeBorder: line,
      clusterBkg: dark ? 'rgba(255,255,255,.025)' : 'rgba(0,0,0,.025)',
      clusterBorder: line,
      edgeLabelBackground: surface,
      titleColor: text,
      actorBkg: node,
      actorBorder: line,
      actorTextColor: text,
      actorLineColor: line,
      signalColor: text2,
      signalTextColor: text,
      labelBoxBkgColor: raised,
      labelBoxBorderColor: line,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: dark ? '#2a2616' : '#FFF6D6',
      noteTextColor: text,
      noteBorderColor: dark ? '#5c5230' : '#E3CE7A',
      activationBkgColor: dark ? '#22303a' : '#DCEFF8',
      activationBorderColor: cyan,
      pie1: cyan,
      pie2: violet,
      pie3: cssVar('--va-green', '#4ADE80'),
      pie4: cssVar('--va-amber', '#FFB454'),
      pie5: cssVar('--va-red', '#FF6B6B'),
      pieStrokeColor: surface,
      pieOuterStrokeColor: line,
      pieTitleTextColor: text,
      pieSectionTextColor: dark ? '#0B0D10' : '#FFFFFF',
      pieLegendTextColor: text,
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: '13.5px'
    }
  })
}

async function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then((x) => x.default)
  const m = await loading
  configure(m)
  return m
}

/** Mermaid's messages, trimmed to what helps someone fix the code. */
export function tidyError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'object' && e && 'str' in e ? String((e as { str: unknown }).str) : String(e)
  return raw.replace(/\s+$/g, '').slice(0, 600) || 'Mermaid could not read this diagram.'
}

/** Run the parser only. Used for the agent's drawings before they are shown, and while typing. */
export async function checkDiagram(code: string): Promise<DiagramCheck> {
  if (!code.trim()) return { ok: false, error: 'The diagram is empty.' }
  try {
    const m = await load()
    await m.parse(code)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: tidyError(e) }
  }
}

export type Rendered = { ok: true; svg: string; width: number; height: number } | { ok: false; error: string }

/** Render to an SVG string, with its natural size (from the viewBox) so the caller can scale it. */
export async function renderDiagram(code: string): Promise<Rendered> {
  if (!code.trim()) return { ok: false, error: 'The diagram is empty.' }
  const id = `va-mmd-${Date.now().toString(36)}-${counter++}`
  try {
    const m = await load()
    await m.parse(code)
    const { svg } = await m.render(id, code)
    const box = /viewBox="([\d.\-e\s]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number)
    return { ok: true, svg, width: box?.[2] || 600, height: box?.[3] || 400 }
  } catch (e) {
    return { ok: false, error: tidyError(e) }
  } finally {
    // a failed render leaves its scratch element (and an error picture) on the page
    document.getElementById(id)?.remove()
    document.getElementById(`d${id}`)?.remove()
  }
}

/** Forget the cached theme, so the next render picks up a light/dark switch. */
export function retheme(): void {
  themed = ''
}
