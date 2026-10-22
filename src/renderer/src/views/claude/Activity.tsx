/** The live activity timeline of one session: prompts, replies and every tool call drawn for what it is. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot, ChevronDown, ChevronRight, CircleCheck, CircleDot, Circle, CircleX, FileCode, FilePen, FilePlus, Globe, ListChecks, Loader,
  Map as MapIcon, MessageCircleQuestion, Search, ShieldX, SquareTerminal, Wrench, type LucideIcon
} from 'lucide-react'
import type { CcEvent } from '@shared/claude'
import { T } from '../../theme'
import { ClaudeMark } from './ClaudeMark'
import { Markdown } from './Markdown'
import { buildFeed, fmtDuration, relPath, toolFamily, type FeedItem, type ToolFamily, type ToolItem } from './feed'

export const FAMILY: Record<ToolFamily, { icon: LucideIcon; color: string; label: string }> = {
  shell: { icon: SquareTerminal, color: T.green, label: 'Terminal' },
  write: { icon: FilePlus, color: T.violet, label: 'New file' },
  edit: { icon: FilePen, color: T.violet, label: 'Edit' },
  read: { icon: FileCode, color: T.cyan, label: 'Read' },
  search: { icon: Search, color: T.cyan, label: 'Search' },
  web: { icon: Globe, color: T.amber, label: 'Web' },
  plan: { icon: MapIcon, color: T.amber, label: 'Plan' },
  todo: { icon: ListChecks, color: T.text2, label: 'Tasks' },
  ask: { icon: MessageCircleQuestion, color: T.amber, label: 'Question' },
  agent: { icon: Bot, color: T.violet, label: 'Sub-agent' },
  other: { icon: Wrench, color: T.text2, label: 'Tool' }
}

const s = (v: unknown) => (typeof v === 'string' ? v : '')
const lineCount = (t: string) => (t ? t.split('\n').length : 0)

function Code({ text, max = 14, start = 1, tint }: { text: string; max?: number; start?: number; tint?: (line: string) => string | undefined }) {
  const [all, setAll] = useState(false)
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const shown = all ? lines : lines.slice(0, max)
  return (
    <div className="va-term va-scroll rounded-lg overflow-x-auto" style={{ border: `1px solid ${T.border}`, fontSize: 11.5, lineHeight: 1.55 }}>
      <div style={{ padding: '6px 0', minWidth: 'fit-content' }}>
        {shown.map((l, i) => (
          <div key={i} className="va-code-line flex" style={{ background: tint?.(l) }}>
            <span style={{ color: '#3a4049', width: 40, textAlign: 'right', paddingRight: 12, userSelect: 'none', flexShrink: 0 }}>{start + i}</span>
            <span style={{ color: '#C9D1D9', whiteSpace: 'pre', paddingRight: 12 }}>{l || ' '}</span>
          </div>
        ))}
      </div>
      {lines.length > max && (
        <button type="button" onClick={() => setAll(!all)} className="w-full text-left px-3 py-1.5" style={{ color: T.text3, fontSize: 11, borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: 'transparent' }}>
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  )
}

/** Line diff of an Edit: common head/tail kept as context, the middle shown as removed + added. */
function Diff({ before, after }: { before: string; after: string }) {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const rows: Array<[' ' | '-' | '+', string]> = [
    ...a.slice(Math.max(0, head - 2), head).map((l) => [' ', l] as [' ', string]),
    ...a.slice(head, a.length - tail).map((l) => ['-', l] as ['-', string]),
    ...b.slice(head, b.length - tail).map((l) => ['+', l] as ['+', string]),
    ...a.slice(a.length - tail, Math.min(a.length, a.length - tail + 2)).map((l) => [' ', l] as [' ', string])
  ]
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 18)
  return (
    <div className="va-term va-scroll rounded-lg overflow-x-auto" style={{ border: `1px solid ${T.border}`, fontSize: 11.5, lineHeight: 1.55 }}>
      <div style={{ padding: '6px 0', minWidth: 'fit-content' }}>
        {shown.map(([k, l], i) => (
          <div key={i} className="flex" style={{ background: k === '-' ? 'rgba(255,107,107,.10)' : k === '+' ? 'rgba(74,222,128,.09)' : undefined }}>
            <span style={{ width: 22, textAlign: 'center', color: k === '-' ? T.red : k === '+' ? T.green : '#3a4049', userSelect: 'none', flexShrink: 0 }}>{k}</span>
            <span style={{ color: k === ' ' ? '#7d858f' : '#D5DCE3', whiteSpace: 'pre', paddingRight: 12 }}>{l || ' '}</span>
          </div>
        ))}
      </div>
      {rows.length > 18 && (
        <button type="button" onClick={() => setAll(!all)} className="w-full text-left px-3 py-1.5" style={{ color: T.text3, fontSize: 11, borderTop: `1px solid ${T.border}`, cursor: 'pointer', background: 'transparent' }}>
          {all ? 'Show less' : `Show all ${rows.length} lines`}
        </button>
      )}
    </div>
  )
}

function Terminal({ item, running }: { item: ToolItem; running: boolean }) {
  const cmd = s(item.input.command) || item.detail
  const out = item.result?.text ?? ''
  const [all, setAll] = useState(false)
  const lines = out ? out.split('\n') : []
  const shown = all || lines.length <= 14 ? lines : lines.slice(-10)
  return (
    <div className="va-term rounded-lg overflow-hidden" style={{ border: `1px solid ${T.border}`, fontSize: 11.5, lineHeight: 1.55 }}>
      <div className="flex items-center gap-1.5 px-3 py-1.5" style={{ borderBottom: `1px solid #15181c`, background: '#0c0e11' }}>
        <span style={{ width: 8, height: 8, borderRadius: 8, background: '#ff5f57' }} />
        <span style={{ width: 8, height: 8, borderRadius: 8, background: '#febc2e' }} />
        <span style={{ width: 8, height: 8, borderRadius: 8, background: '#28c840' }} />
        <span className="ml-2" style={{ color: T.text3, fontSize: 10.5 }}>{item.name}{s(item.input.description) ? ` · ${s(item.input.description)}` : ''}</span>
      </div>
      <div className="va-scroll overflow-x-auto" style={{ padding: '8px 12px' }}>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          <span style={{ color: T.green }}>{item.name === 'PowerShell' ? 'PS>' : '$'}</span> <span style={{ color: '#E6EDF3' }}>{cmd}</span>
        </div>
        {lines.length > shown.length && (
          <button type="button" onClick={() => setAll(true)} style={{ color: T.text3, fontSize: 11, cursor: 'pointer', background: 'transparent', padding: '2px 0' }}>
            … {lines.length - shown.length} earlier lines
          </button>
        )}
        {shown.length > 0 && <div style={{ color: item.result?.isError ? '#ff9b9b' : '#9aa4af', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 2 }}>{shown.join('\n')}</div>}
        {!item.result && running && <span className="va-pulse" style={{ color: T.green }}>▍</span>}
      </div>
    </div>
  )
}

function Todos({ todos }: { todos: Array<Record<string, unknown>> }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg px-3 py-2" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
      {todos.map((t, i) => {
        const st = s(t.status)
        const Icon = st === 'completed' ? CircleCheck : st === 'in_progress' ? CircleDot : Circle
        return (
          <div key={i} className="flex items-center gap-2 text-xs" style={{ color: st === 'completed' ? T.text3 : T.text2 }}>
            <Icon size={13} style={{ color: st === 'completed' ? T.green : st === 'in_progress' ? T.violet : T.text3, flexShrink: 0 }} className={st === 'in_progress' ? 'va-pulse' : undefined} />
            <span style={{ textDecoration: st === 'completed' ? 'line-through' : undefined }}>{s(t.content) || s(t.activeForm)}</span>
          </div>
        )
      })}
    </div>
  )
}

/** What goes inside a tool card when it is open. */
function ToolBody({ item, running }: { item: ToolItem; running: boolean }) {
  const fam = toolFamily(item.name)
  const i = item.input
  const res = item.result
  const resultBlock = res?.text ? <Code text={res.text} max={10} tint={res.isError ? () => 'rgba(255,107,107,.06)' : undefined} /> : null
  switch (fam) {
    case 'shell':
      return <Terminal item={item} running={running} />
    case 'write':
      return s(i.content) ? <Code text={s(i.content)} max={14} /> : resultBlock
    case 'edit': {
      if (Array.isArray(i.edits)) return <div className="flex flex-col gap-1.5">{(i.edits as Record<string, unknown>[]).map((e, k) => <Diff key={k} before={s(e.old_string)} after={s(e.new_string)} />)}</div>
      if (s(i.old_string) || s(i.new_string)) return <Diff before={s(i.old_string)} after={s(i.new_string)} />
      return s(i.new_source) ? <Code text={s(i.new_source)} /> : resultBlock
    }
    case 'todo':
      return Array.isArray(i.todos) ? <Todos todos={i.todos as Array<Record<string, unknown>>} /> : resultBlock
    case 'plan':
      return s(i.plan) ? <div className="rounded-lg px-3 py-2" style={{ background: T.bg, border: `1px solid ${T.border}` }}><Markdown text={s(i.plan)} /></div> : resultBlock
    case 'ask':
      return res ? <div className="text-xs rounded-lg px-3 py-2" style={{ background: T.amberTint, color: T.text2 }}>{res.text}</div> : null
    case 'agent':
      return s(i.prompt) ? <div className="rounded-lg px-3 py-2" style={{ background: T.bg, border: `1px solid ${T.border}` }}><Markdown text={s(i.prompt)} /></div> : resultBlock
    case 'read':
    case 'search':
    case 'web':
      return resultBlock
    default: {
      const json = JSON.stringify(i, null, 2)
      return (
        <div className="flex flex-col gap-1.5">
          {json !== '{}' && <Code text={json} max={10} />}
          {resultBlock}
        </div>
      )
    }
  }
}

/** One-word badge on the right of a tool card header: lines added, matches, failure. */
function badge(item: ToolItem): ReactNode {
  const fam = toolFamily(item.name)
  const i = item.input
  if (item.result?.isError) return <span style={{ color: T.red }}>failed</span>
  if (fam === 'write' && s(i.content)) return <span style={{ color: T.green }}>+{lineCount(s(i.content))}</span>
  if (fam === 'edit') {
    const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i]
    const minus = edits.reduce((n, e) => n + lineCount(s(e.old_string)), 0)
    const plus = edits.reduce((n, e) => n + lineCount(s(e.new_string)), 0)
    return (
      <span>
        <span style={{ color: T.red }}>−{minus}</span> <span style={{ color: T.green }}>+{plus}</span>
      </span>
    )
  }
  if ((fam === 'read' || fam === 'search') && item.result) return <span style={{ color: T.text3 }}>{lineCount(item.result.text)} lines</span>
  if (fam === 'todo' && Array.isArray(i.todos)) {
    const todos = i.todos as Record<string, unknown>[]
    return <span style={{ color: T.text3 }}>{todos.filter((t) => t.status === 'completed').length}/{todos.length}</span>
  }
  return null
}

function ToolCard({ item, running, workspace, onOpenFile }: { item: ToolItem; running: boolean; workspace: string; onOpenFile?: (rel: string) => void }) {
  const fam = toolFamily(item.name)
  const f = FAMILY[fam]
  // the interesting ones start open; reads and searches stay folded
  const [open, setOpen] = useState(fam === 'shell' || fam === 'edit' || fam === 'todo' || fam === 'plan' || fam === 'ask' || (fam === 'write' && lineCount(s(item.input.content)) <= 30))
  const pending = !item.result && running
  const Icon = f.icon
  const rel = (fam === 'write' || fam === 'edit' || fam === 'read') && item.detail ? relPath(item.detail, workspace) : null
  const quiet = item.name === 'ToolSearch'
  if (quiet) {
    return (
      <div className="flex items-center gap-2 text-xs pl-1" style={{ color: T.text3 }}>
        <Search size={11} /> looked up tools {item.detail && <span style={{ fontFamily: T.mono }}>{item.detail}</span>}
      </div>
    )
  }
  return (
    <div className="va-tool-card va-fade rounded-xl overflow-hidden" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 text-left" style={{ cursor: 'pointer', background: 'transparent' }}>
        <span className="inline-flex items-center justify-center rounded-md" style={{ width: 22, height: 22, background: `${f.color}1a`, color: f.color, flexShrink: 0 }}>
          <Icon size={13} />
        </span>
        <span className="text-xs font-medium" style={{ color: T.text, flexShrink: 0 }}>{item.name}</span>{' '}
        <span className="text-xs truncate min-w-0 flex-1" style={{ color: T.text2, fontFamily: T.mono }} title={item.detail}>
          {rel ?? item.detail}
        </span>
        <span className="text-xs" style={{ fontFamily: T.mono, flexShrink: 0 }}>{badge(item)}</span>
        {pending ? (
          <Loader size={13} className="va-spin" style={{ color: f.color, flexShrink: 0 }} />
        ) : item.result?.isError ? (
          <CircleX size={13} style={{ color: T.red, flexShrink: 0 }} />
        ) : item.result ? (
          <CircleCheck size={13} style={{ color: T.green, opacity: 0.8, flexShrink: 0 }} />
        ) : null}
        {open ? <ChevronDown size={13} style={{ color: T.text3, flexShrink: 0 }} /> : <ChevronRight size={13} style={{ color: T.text3, flexShrink: 0 }} />}
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2">
          <ToolBody item={item} running={running} />
          {rel && onOpenFile && (fam === 'write' || fam === 'edit') && (
            <button type="button" onClick={() => onOpenFile(rel)} className="self-start text-xs" style={{ color: T.cyan, cursor: 'pointer', background: 'transparent' }}>
              Open {rel} in Files →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Divider({ color, children }: { color: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1 va-fade">
      <div className="flex-1" style={{ height: 1, background: `linear-gradient(90deg, transparent, ${color}55)` }} />
      <span className="text-xs inline-flex items-center gap-1.5" style={{ color }}>{children}</span>
      <div className="flex-1" style={{ height: 1, background: `linear-gradient(90deg, ${color}55, transparent)` }} />
    </div>
  )
}

function Row({ item, running, workspace, onOpenFile }: { item: FeedItem; running: boolean; workspace: string; onOpenFile?: (rel: string) => void }) {
  switch (item.type) {
    case 'user':
      return (
        <div className="flex justify-end va-fade">
          <div className="rounded-2xl px-3.5 py-2 text-sm" style={{ maxWidth: '82%', background: T.cyanTint, border: `1px solid ${T.cyanBorder}`, color: T.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderBottomRightRadius: 6 }}>
            <div className="text-xs mb-0.5" style={{ color: T.cyan }}>you</div>
            {item.text}
          </div>
        </div>
      )
    case 'text':
      return (
        <div className="flex gap-2.5 va-fade">
          <div style={{ paddingTop: 2 }}><ClaudeMark size={16} /></div>
          <div className="min-w-0 flex-1"><Markdown text={item.text} /></div>
        </div>
      )
    case 'tool':
      return <ToolCard item={item} running={running} workspace={workspace} onOpenFile={onOpenFile} />
    case 'denied':
      return (
        <div className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs va-fade" style={{ background: T.redTint, border: `1px solid rgba(255,107,107,.3)`, color: T.text2 }}>
          <ShieldX size={13} style={{ color: T.red, flexShrink: 0, marginTop: 1 }} />
          <span><b style={{ color: T.red, fontWeight: 500 }}>blocked</b> · {item.text}</span>
        </div>
      )
    case 'error':
      return (
        <div className="rounded-lg px-3 py-2 text-xs va-fade" style={{ background: T.redTint, border: `1px solid ${T.red}`, color: T.red, whiteSpace: 'pre-wrap' }}>
          error · {item.text}
        </div>
      )
    case 'interrupt':
      return <Divider color={T.amber}>stopped · {item.text}</Divider>
    case 'status':
      return <Divider color={T.text3}>{item.text}</Divider>
    case 'result': {
      const stats = [item.durationMs ? fmtDuration(item.durationMs) : '', item.costUsd ? `$${item.costUsd.toFixed(3)}` : '', item.turns ? `${item.turns} turn${item.turns > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')
      return (
        <div className="flex flex-col gap-2">
          {!item.repeat && item.text && (
            <div className="flex gap-2.5 va-fade">
              <div style={{ paddingTop: 2 }}><ClaudeMark size={16} /></div>
              <div className="min-w-0 flex-1"><Markdown text={item.text} /></div>
            </div>
          )}
          <Divider color={T.green}>
            <CircleCheck size={12} /> done{stats ? ` · ${stats}` : ''}
          </Divider>
        </div>
      )
    }
  }
}

function useElapsed(since: number | null, on: boolean): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return since && on ? fmtDuration(Math.max(0, now - since)) : ''
}

export function Activity({ events, running, waiting, since, workspace, onOpenFile }: {
  events: CcEvent[]
  running: boolean
  waiting: boolean
  since: number | null
  workspace: string
  onOpenFile?: (rel: string) => void
}) {
  const feed = useMemo(() => buildFeed(events), [events])
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const elapsed = useElapsed(since, running)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [feed, running])
  return (
    <div
      ref={ref}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}
      className="va-scroll flex-1 overflow-y-auto"
      style={{ minHeight: 160 }}
    >
      <div className="flex flex-col gap-2.5 p-4 mx-auto" style={{ maxWidth: 860 }}>
        {feed.length === 0 && !running && (
          <div className="flex flex-col items-center gap-3 py-16" style={{ color: T.text3 }}>
            <ClaudeMark size={40} />
            <div className="text-sm">Nothing yet. Give it a task by voice or below.</div>
          </div>
        )}
        {feed.map((item) => <Row key={item.key} item={item} running={running} workspace={workspace} onOpenFile={onOpenFile} />)}
        {running && (
          <div className="flex items-center gap-2.5 py-1.5 va-fade">
            <ClaudeMark size={18} working={!waiting} />
            <span className={waiting ? 'text-sm' : 'text-sm va-shimmer'} style={{ color: waiting ? T.amber : '#E8A58C' }}>
              {waiting ? 'Waiting for you…' : 'Working…'}
            </span>
            {elapsed && <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono }}>{elapsed}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
