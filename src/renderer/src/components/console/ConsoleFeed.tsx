/**
 * The live console: everything the app does, as it happens. One row per event in plain words
 * ("Heard: …", "Reply cut off: you spoke over it"), coloured by the part of the app it came from.
 * Used full-page (Console view) and beside the chat (`compact`).
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Check, Copy, Pause, Play, Search, Trash2, X } from 'lucide-react'
import { CONSOLE_CATEGORIES, describe, rowText, type ConsoleCategory, type ConsoleEntry, type ConsoleRow } from '@shared/console'
import { T, alpha } from '../../theme'
import { useConsole } from '../../state/console'
import { UsageStrip } from './UsageStrip'

const CAT_COLOR: Record<ConsoleCategory, string> = {
  you: T.cyan,
  turn: T.violet,
  voice: T.green,
  playback: T.steel,
  claude: T.claude,
  system: T.text3
}
const CAT_SHORT: Record<ConsoleCategory, string> = { you: 'you', turn: 'brain', voice: 'voice', playback: 'play', claude: 'claude', system: 'system' }

const TONE_COLOR: Record<ConsoleRow['tone'], string> = {
  plain: T.text,
  good: T.green,
  warn: T.amber,
  bad: T.red,
  accent: T.text,
  dim: T.text2
}

/** Rows drawn at once; older ones are still searchable by narrowing the filter. */
const MAX_ROWS = 700

const PREFS_KEY = 'va.console'
type Prefs = { off: ConsoleCategory[]; verbose: boolean; problems: boolean }
const readPrefs = (): Prefs => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>
    return { off: Array.isArray(p.off) ? p.off : [], verbose: !!p.verbose, problems: !!p.problems }
  } catch {
    return { off: [], verbose: false, problems: false }
  }
}

const clock = (t: number): string => {
  const d = new Date(t)
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

type Shown = { e: ConsoleEntry; r: ConsoleRow }

export function ConsoleFeed({ compact = false }: { compact?: boolean }) {
  const entries = useConsole((s) => s.entries)
  const trimmed = useConsole((s) => s.trimmed)
  const clear = useConsole((s) => s.clear)
  const [prefs, setPrefs] = useState<Prefs>(readPrefs)
  const [query, setQuery] = useState('')
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
    } catch {
      // a preference; fine to lose
    }
  }, [prefs])

  // describe() once per entry, however often the filters change
  const cache = useRef(new Map<number, ConsoleRow>())
  const described = useMemo<Shown[]>(() => {
    const c = cache.current
    const out = entries.map((e) => {
      let r = c.get(e.id)
      if (!r) c.set(e.id, (r = describe(e)))
      return { e, r }
    })
    if (c.size > entries.length + 2000) {
      const live = new Set(entries.map((e) => e.id))
      for (const id of c.keys()) if (!live.has(id)) c.delete(id)
    }
    return out
  }, [entries])

  const counts = useMemo(() => {
    const n: Record<ConsoleCategory, number> = { you: 0, turn: 0, voice: 0, playback: 0, claude: 0, system: 0 }
    let problems = 0
    for (const { r } of described) {
      if (r.noisy && !prefs.verbose) continue
      n[r.cat]++
      if (r.tone === 'bad' || r.tone === 'warn') problems++
    }
    return { n, problems }
  }, [described, prefs.verbose])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const off = new Set(prefs.off)
    const all = described.filter(({ e, r }) => {
      if (pausedAt !== null && e.id > pausedAt) return false
      if (off.has(r.cat)) return false
      if (r.noisy && !prefs.verbose) return false
      if (prefs.problems && r.tone !== 'bad' && r.tone !== 'warn') return false
      if (q && !rowText(e, r).toLowerCase().includes(q)) return false
      return true
    })
    return { rows: all.slice(-MAX_ROWS), hidden: Math.max(0, all.length - MAX_ROWS), total: all.length }
  }, [described, prefs, query, pausedAt])

  const waiting = pausedAt === null ? 0 : entries.filter((e) => e.id > pausedAt).length
  const lastId = entries.length ? entries[entries.length - 1]!.id : 0

  // stay pinned to the newest row unless the user scrolled up to read
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [visible.rows, atBottom])

  const onScroll = (): void => {
    const el = scroller.current
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }
  const jump = (): void => {
    setAtBottom(true)
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }

  const toggleCat = (id: ConsoleCategory): void => setPrefs((p) => ({ ...p, off: p.off.includes(id) ? p.off.filter((x) => x !== id) : [...p.off, id] }))
  const only = (id: ConsoleCategory): void => setPrefs((p) => ({ ...p, off: p.off.length === CONSOLE_CATEGORIES.length - 1 && !p.off.includes(id) ? [] : CONSOLE_CATEGORIES.map((c) => c.id).filter((x) => x !== id) }))

  const copy = async (): Promise<void> => {
    const text = visible.rows.map(({ e, r }) => rowText(e, r)).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // clipboard refused (window not focused)
    }
  }

  const tool = (active: boolean, color: string = T.cyan) => ({
    height: 26,
    padding: '0 9px',
    borderRadius: 7,
    border: `1px solid ${active ? alpha(color, 45) : T.border}`,
    background: active ? alpha(color, 12) : 'transparent',
    color: active ? color : T.text2,
    cursor: 'pointer',
    fontSize: 12,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    whiteSpace: 'nowrap' as const
  })

  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="console-feed">
      <div className="flex flex-col gap-2" style={{ padding: compact ? '8px 10px' : '10px 16px', borderBottom: `1px solid ${T.border}` }}>
        <div className="flex items-center gap-1.5 flex-wrap">
          {CONSOLE_CATEGORIES.map((c) => {
            const on = !prefs.off.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                title={`${c.hint}. Click to hide or show; double-click to show only this.`}
                onClick={() => toggleCat(c.id)}
                onDoubleClick={() => only(c.id)}
                style={{ ...tool(on, CAT_COLOR[c.id]), opacity: on ? 1 : 0.55 }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 4, background: CAT_COLOR[c.id], opacity: on ? 1 : 0.4 }} />
                {compact ? CAT_SHORT[c.id] : c.label}
                <span style={{ color: T.text3, fontFamily: T.mono, fontSize: 10.5 }}>{counts.n[c.id]}</span>
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <label className="inline-flex items-center gap-1.5 flex-1" style={{ height: 26, minWidth: compact ? 120 : 200, padding: '0 8px', borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg }}>
            <Search size={12} style={{ color: T.text3, flexShrink: 0 }} />
            <input
              aria-label="Search the console"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="flex-1 min-w-0 text-xs"
              style={{ background: 'transparent', border: 'none', color: T.text }}
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery('')} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', padding: 0, display: 'flex' }}>
                <X size={12} />
              </button>
            )}
          </label>
          <button type="button" aria-pressed={prefs.problems} title="Only warnings and failures" onClick={() => setPrefs((p) => ({ ...p, problems: !p.problems }))} style={tool(prefs.problems, T.amber)}>
            Problems
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: counts.problems ? T.amber : T.text3 }}>{counts.problems}</span>
          </button>
          <button type="button" aria-pressed={prefs.verbose} title="Also show the chatty events: partial transcripts, state changes, statistics" onClick={() => setPrefs((p) => ({ ...p, verbose: !p.verbose }))} style={tool(prefs.verbose)}>
            Verbose
          </button>
          <button
            type="button"
            aria-pressed={pausedAt !== null}
            title={pausedAt !== null ? 'Show what happened while paused and carry on' : 'Freeze the list to read it; events keep being collected'}
            onClick={() => setPausedAt(pausedAt === null ? lastId : null)}
            style={tool(pausedAt !== null, T.amber)}
          >
            {pausedAt !== null ? <Play size={12} /> : <Pause size={12} />}
            {pausedAt !== null ? `Resume${waiting ? ` (${waiting} new)` : ''}` : 'Pause'}
          </button>
          <button type="button" title="Copy the rows shown" onClick={() => void copy()} style={tool(copied, T.green)}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {!compact && (copied ? 'Copied' : 'Copy')}
          </button>
          <button
            type="button"
            title="Empty the console (the log files keep everything)"
            onClick={() => {
              clear()
              setPausedAt(null)
              setOpen(null)
            }}
            style={tool(false)}
          >
            <Trash2 size={12} />
            {!compact && 'Clear'}
          </button>
        </div>
      </div>

      <UsageStrip entries={entries} compact={compact} />

      <div className="relative flex-1 min-h-0">
        <div ref={scroller} onScroll={onScroll} className="va-scroll absolute inset-0 overflow-y-auto" style={{ padding: '6px 0 10px', background: T.bg }} role="log" aria-live="off" aria-label="Live console">
          {(visible.hidden > 0 || trimmed > 0) && (
            <div className="text-xs" style={{ color: T.text3, padding: '4px 16px 8px' }}>
              {visible.hidden > 0 ? `${visible.hidden} earlier rows not drawn; narrow the filter or search to reach them.` : `${trimmed} older events scrolled away; the log files keep everything.`}
            </div>
          )}
          {visible.rows.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-1 text-sm" style={{ color: T.text3, padding: '48px 16px', textAlign: 'center' }}>
              <span>{entries.length === 0 ? 'Nothing yet.' : 'Nothing matches these filters.'}</span>
              <span className="text-xs">{entries.length === 0 ? 'Speak or type, and every step shows up here as it happens.' : 'Turn a category back on, or clear the search.'}</span>
            </div>
          )}
          {visible.rows.map(({ e, r }) => (
            <RowView key={e.id} e={e} r={r} compact={compact} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} />
          ))}
        </div>
        {!atBottom && (
          <button
            type="button"
            onClick={jump}
            className="absolute va-fade inline-flex items-center gap-1.5 text-xs"
            style={{ right: 16, bottom: 12, height: 28, padding: '0 10px', borderRadius: 14, background: T.raised, color: T.text, border: `1px solid ${T.borderStrong}`, boxShadow: `0 4px 14px ${T.shadow}`, cursor: 'pointer' }}
          >
            <ArrowDown size={12} /> Latest
          </button>
        )}
      </div>
    </div>
  )
}

const RowView = memo(function RowView({ e, r, compact, open, onToggle }: { e: ConsoleEntry; r: ConsoleRow; compact: boolean; open: boolean; onToggle: () => void }) {
  const color = CAT_COLOR[r.cat]
  const strong = r.tone === 'accent' || r.tone === 'bad'
  const raw = open ? JSON.stringify(e.kind === 'trace' ? { ev: e.name, ...(e.turn ? { turn: e.turn } : {}), ...e.data } : { scope: e.name, level: e.level, msg: e.msg, ...e.data }, null, 2) : ''
  return (
    <>
      {r.turnStart && (
        <div className="flex items-center gap-2" style={{ padding: compact ? '10px 10px 4px' : '12px 16px 4px' }}>
          <span style={{ height: 1, flex: 1, background: T.border }} />
          <span style={{ color: T.text3, fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase' }}>new turn</span>
          <span style={{ height: 1, flex: 1, background: T.border }} />
        </div>
      )}
      <div
        onClick={onToggle}
        className="va-tree-row flex items-start"
        style={{
          gap: compact ? 8 : 10,
          padding: compact ? '3px 10px' : '3px 16px',
          cursor: 'pointer',
          borderLeft: `2px solid ${r.tone === 'bad' ? T.red : r.tone === 'warn' ? T.amber : 'transparent'}`,
          background: r.tone === 'bad' ? alpha(T.red, 6) : open ? T.wash : undefined
        }}
      >
        <span style={{ color: T.text3, fontFamily: T.mono, fontSize: 11, lineHeight: '19px', flexShrink: 0 }}>{compact ? clock(e.t).slice(3, 10) : clock(e.t)}</span>
        <span className="inline-flex items-center gap-1.5" style={{ width: compact ? 8 : 62, height: 19, flexShrink: 0, color, fontSize: 11 }} title={CAT_SHORT[r.cat]}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: color, flexShrink: 0 }} />
          {!compact && CAT_SHORT[r.cat]}
        </span>
        <span className="min-w-0 flex-1" style={{ fontSize: 12.5, lineHeight: '19px', wordBreak: 'break-word' }}>
          <span style={{ color: TONE_COLOR[r.tone], fontWeight: strong ? 500 : 400 }}>{r.title}</span>
          {r.detail && <span style={{ color: T.text3, marginLeft: 8, fontSize: 11.5 }}>{r.detail}</span>}
        </span>
      </div>
      {open && (
        <pre
          className="va-scroll"
          style={{ margin: compact ? '2px 10px 6px 10px' : '2px 16px 6px 104px', padding: '8px 10px', borderRadius: 8, background: T.surface, border: `1px solid ${T.border}`, color: T.text2, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}
        >
          {raw}
        </pre>
      )}
    </>
  )
})
