/**
 * What the run has spent, above the console rows: tokens and list-price dollars for the replies, and on
 * expanding it, the split by model, how much each tool fed back into the prompt, and the Claude Code sessions.
 */
import { useMemo, useState } from 'react'
import { ChevronRight, Coins } from 'lucide-react'
import type { ConsoleEntry } from '@shared/console'
import { fmtTokens, fmtUsd } from '@shared/pricing'
import { summarizeUsage } from '@shared/usage'
import { T, alpha } from '../../theme'
import { useStore } from '../../state/store'

const cell = { padding: '3px 12px 3px 0', whiteSpace: 'nowrap' } as const
const numCell = { ...cell, textAlign: 'right', fontFamily: T.mono } as const

function Table({ title, head, rows, note }: { title: string; head: string[]; rows: string[][]; note?: string }) {
  return (
    <div className="min-w-0">
      <div style={{ color: T.text3, fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 4 }}>{title}</div>
      <table style={{ borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr style={{ color: T.text3 }}>
            {head.map((h, i) => <th key={h} style={{ ...(i ? numCell : cell), fontWeight: 400, fontFamily: undefined }}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]} style={{ color: T.text2 }}>
              {r.map((v, i) => <td key={i} style={i ? numCell : { ...cell, color: T.text, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={i ? undefined : v}>{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div style={{ color: T.text3, fontSize: 11, marginTop: 4, maxWidth: 420, lineHeight: 1.5 }}>{note}</div>}
    </div>
  )
}

export function UsageStrip({ entries, compact }: { entries: ConsoleEntry[]; compact: boolean }) {
  const [open, setOpen] = useState(false)
  const u = useMemo(() => summarizeUsage(entries), [entries])
  const sessions = useStore((s) => s.claudeSessions)
  const cc = sessions.filter((s) => (s.tokensIn ?? 0) > 0 || s.costUsd > 0)
  if (u.turns === 0 && cc.length === 0) return null
  const cachedPct = u.inputTokens ? Math.round((u.cacheReadTokens / u.inputTokens) * 100) : 0
  const cost = u.unpricedTurns === u.turns && u.turns > 0 ? 'price unknown' : `${fmtUsd(u.costUsd)}${u.unpricedTurns ? ' +' : ''}`
  return (
    <div style={{ borderBottom: `1px solid ${T.border}`, background: alpha(T.violet, 4) }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
        style={{ padding: compact ? '6px 10px' : '6px 16px', cursor: 'pointer', background: 'transparent', color: T.text2, fontSize: 12 }}
        title="Tokens and cost of the replies in this console. Click for the split by model and tool."
      >
        <ChevronRight size={12} style={{ color: T.text3, transform: open ? 'rotate(90deg)' : undefined, transition: 'transform .15s ease', flexShrink: 0 }} />
        <Coins size={13} style={{ color: T.violet, flexShrink: 0 }} />
        <span className="truncate">
          <span style={{ color: T.text }}>{u.turns} {u.turns === 1 ? 'reply' : 'replies'}</span>
          {' · '}
          <span style={{ fontFamily: T.mono }}>{fmtTokens(u.inputTokens)}</span> in
          {u.inputTokens > 0 && <span style={{ color: cachedPct >= 50 ? T.green : T.text3 }}> ({cachedPct}% cached)</span>}
          {' · '}
          <span style={{ fontFamily: T.mono }}>{fmtTokens(u.outputTokens)}</span> out
        </span>
        <span className="ml-auto" style={{ color: T.text, fontFamily: T.mono, flexShrink: 0 }}>{cost}</span>
      </button>
      {open && (
        <div className="va-fade flex flex-wrap gap-x-8 gap-y-3" style={{ padding: compact ? '2px 10px 10px 32px' : '2px 16px 12px 38px' }}>
          {u.byModel.length > 0 && (
            <Table
              title="Replies by model"
              head={['Model', 'Replies', 'In', 'Cached', 'Out', 'Cost']}
              rows={u.byModel.map((m) => [m.model, String(m.turns), fmtTokens(m.inputTokens), fmtTokens(m.cacheReadTokens), fmtTokens(m.outputTokens), m.costUsd === undefined ? 'no price' : fmtUsd(m.costUsd)])}
              note={`Biggest single prompt: ${fmtTokens(u.biggestTurnTokens)} tokens. A reply that uses a tool sends the prompt twice. Costs are list prices; cached input is about a tenth of the price.`}
            />
          )}
          {u.byTool.length > 0 && (
            <Table
              title="Tools: what their results added to the prompt"
              head={['Tool', 'Calls', 'Tokens']}
              rows={u.byTool.slice(0, 8).map((t) => [t.name, String(t.calls), `~${fmtTokens(t.resultTokens)}`])}
            />
          )}
          {cc.length > 0 && (
            <Table
              title="Claude Code sessions"
              head={['Session', 'In', 'Out', 'At API prices']}
              rows={cc.map((s) => [s.name, fmtTokens(s.tokensIn ?? 0), fmtTokens(s.tokensOut ?? 0), fmtUsd(s.costUsd)])}
              note="On your Claude subscription this is plan usage, not a bill."
            />
          )}
        </div>
      )}
    </div>
  )
}
