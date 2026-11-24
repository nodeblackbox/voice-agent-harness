/** What changed between two versions of a diagram's code: removed lines in red, added lines in green. */
import { useMemo, useState } from 'react'
import { lineDiff, type DiffLine } from '@shared/diagram'
import { T, TERM } from '../../theme'

const CONTEXT = 2

type Row = { type: 'line'; line: DiffLine } | { type: 'gap'; from: number; count: number }

/** Long unchanged stretches fold away, keeping a couple of lines around each change. */
export function foldUnchanged(lines: DiffLine[], context = CONTEXT): Row[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true
  })
  const rows: Row[] = []
  let i = 0
  while (i < lines.length) {
    if (keep[i]) {
      rows.push({ type: 'line', line: lines[i]! })
      i++
      continue
    }
    let j = i
    while (j < lines.length && !keep[j]) j++
    // folding two or three lines saves nothing
    if (j - i <= 3) for (let k = i; k < j; k++) rows.push({ type: 'line', line: lines[k]! })
    else rows.push({ type: 'gap', from: i, count: j - i })
    i = j
  }
  return rows
}

export function DiffView({ before, after, maxHeight = 380 }: { before: string; after: string; maxHeight?: number }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after])
  const [open, setOpen] = useState<Set<number>>(new Set())
  const rows = useMemo(() => foldUnchanged(lines), [lines])
  const changed = lines.some((l) => l.kind !== 'same')

  const line = (l: DiffLine, key: string | number) => {
    const bg = l.kind === 'added' ? TERM.plus : l.kind === 'removed' ? TERM.minus : 'transparent'
    const sign = l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : ' '
    const color = l.kind === 'added' ? '#7EE2A0' : l.kind === 'removed' ? '#FF9B9B' : TERM.dimDiff
    return (
      <div key={key} data-kind={l.kind} className="flex" style={{ background: bg }}>
        <span style={{ width: 34, textAlign: 'right', color: TERM.gutter, flexShrink: 0, userSelect: 'none' }}>{l.a ?? ''}</span>
        <span style={{ width: 34, textAlign: 'right', color: TERM.gutter, flexShrink: 0, userSelect: 'none' }}>{l.b ?? ''}</span>
        <span style={{ width: 26, textAlign: 'center', color, flexShrink: 0, userSelect: 'none' }}>{sign}</span>
        <span style={{ color: l.kind === 'same' ? TERM.dimDiff : TERM.diff, whiteSpace: 'pre-wrap', wordBreak: 'break-word', paddingRight: 14 }}>{l.text || ' '}</span>
      </div>
    )
  }

  return (
    <div className="va-scroll" style={{ background: TERM.bg, fontFamily: T.mono, fontSize: 12, lineHeight: 1.7, padding: '10px 0', maxHeight, overflow: 'auto' }}>
      {!changed && <div style={{ color: TERM.dim, padding: '6px 16px' }}>No changes.</div>}
      {changed &&
        rows.map((r, i) =>
          r.type === 'line' ? (
            line(r.line, i)
          ) : open.has(r.from) ? (
            lines.slice(r.from, r.from + r.count).map((l, j) => line(l, `${i}-${j}`))
          ) : (
            <button key={i} onClick={() => setOpen(new Set(open).add(r.from))} className="block w-full text-left" style={{ background: 'rgba(255,255,255,.03)', border: 'none', color: TERM.dim, cursor: 'pointer', padding: '1px 0 1px 94px', fontFamily: 'inherit', fontSize: 11 }}>
              ⋯ {r.count} unchanged lines
            </button>
          )
        )}
    </div>
  )
}
