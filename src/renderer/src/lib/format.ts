import { fmtUsd } from '@shared/pricing'

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0s'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(n / 1000)}k`
}

/** Tooltip for a reply's token readout: "10.2k tokens in (9.6k from cache), 23 out, 2 model calls, $0.0004 at list price". */
export function usageTitle(m: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number; steps?: number }): string {
  const parts = [`${formatTokens(m.inputTokens ?? 0)} tokens in${m.cacheReadTokens ? ` (${formatTokens(m.cacheReadTokens)} from cache)` : ''}`, `${formatTokens(m.outputTokens ?? 0)} out`]
  if ((m.steps ?? 0) > 1) parts.push(`${m.steps} model calls`)
  if (m.costUsd !== undefined) parts.push(`${fmtUsd(m.costUsd)} at list price`)
  return parts.join(', ')
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function faviconUrl(url: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=32`
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function parseArgs(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

export function envToLines(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}
