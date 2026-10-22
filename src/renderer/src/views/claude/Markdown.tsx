/**
 * Just enough Markdown for Claude Code's replies: headings, bullet/numbered lists, fenced code,
 * **bold**, *italic*, `code` and [links](url). Builds React nodes (never HTML strings).
 */
import type { ReactNode } from 'react'
import { T } from '../../theme'

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let i = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const k = `${key}-${i++}`
    if (m[1]) out.push(<code key={k} style={{ fontFamily: T.mono, fontSize: '0.92em', background: T.raised, color: '#E8B7A6', borderRadius: 4, padding: '1px 5px' }}>{tok.slice(1, -1)}</code>)
    else if (m[2]) out.push(<b key={k} style={{ color: T.text, fontWeight: 600 }}>{tok.slice(2, -2)}</b>)
    else if (m[3]) out.push(<i key={k}>{tok.slice(1, -1)}</i>)
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok) ?? []
      out.push(
        <a key={k} href={href} onClick={(e) => { e.preventDefault(); if (href && /^https?:/.test(href)) void window.api.shell.open(href) }} style={{ color: T.cyan, textDecoration: 'none' }}>
          {label}
        </a>
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let n = 0
  while (i < lines.length) {
    const line = lines[i]!
    const key = `b${n++}`
    if (/^```/.test(line)) {
      const lang = line.slice(3).trim()
      const body: string[] = []
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!)
      i++
      blocks.push(
        <pre key={key} className="va-term va-scroll rounded-lg overflow-x-auto" style={{ margin: 0, padding: '10px 12px', fontSize: 12, color: '#C9D1D9', border: `1px solid ${T.border}` }}>
          {lang && <div style={{ color: T.text3, fontSize: 10.5, marginBottom: 4 }}>{lang}</div>}
          {body.join('\n')}
        </pre>
      )
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push(<div key={key} style={{ color: T.text, fontWeight: 600, fontSize: h[1]!.length <= 2 ? 15 : 13.5, marginTop: 4 }}>{inline(h[2]!, key)}</div>)
      i++
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: Array<{ text: string; ordered: string | null; depth: number }> = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) {
        const m = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(lines[i]!)!
        items.push({ text: m[3]!, ordered: /\d/.test(m[2]!) ? m[2]! : null, depth: Math.min(3, Math.floor(m[1]!.length / 2)) })
        i++
      }
      blocks.push(
        <div key={key} className="flex flex-col gap-1">
          {items.map((it, j) => (
            <div key={j} className="flex gap-2" style={{ paddingLeft: it.depth * 16 }}>
              <span style={{ color: T.text3, minWidth: it.ordered ? 18 : 8, fontFamily: it.ordered ? T.mono : undefined, fontSize: it.ordered ? 11.5 : undefined }}>{it.ordered ?? '•'}</span>
              <span className="min-w-0">{inline(it.text, `${key}-${j}`)}</span>
            </div>
          ))}
        </div>
      )
      continue
    }
    if (!line.trim()) {
      i++
      continue
    }
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !/^```|^#{1,4}\s|^\s*([-*•]|\d+[.)])\s+/.test(lines[i]!)) para.push(lines[i++]!)
    blocks.push(<p key={key} style={{ margin: 0 }}>{inline(para.join(' '), key)}</p>)
  }
  return <div className="flex flex-col gap-2" style={{ color: T.text2, fontSize: 13, lineHeight: 1.6, wordBreak: 'break-word' }}>{blocks}</div>
}
