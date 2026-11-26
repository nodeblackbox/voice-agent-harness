// The left column of the Playbooks page: new buttons, search, filters, the list in groups, and what is running now.
import { useMemo, useState } from 'react'
import { AlertTriangle, ChevronRight, CircleAlert, FolderOpen, ListChecks, Plus, Search, Workflow, X, Zap } from 'lucide-react'
import type { PlaybookInfo, PlaybooksState, RunbookRun } from '@shared/types'
import { T, alpha } from '../../theme'
import { Btn, Toggle } from '../../components/primitives'
import { ago, issueText, RUN_STATUS, triggerLine } from './parts'

export type Filter = 'all' | 'on' | 'off' | 'runbooks' | 'jev' | 'problems'

const FILTERS: Array<{ id: Filter; label: string; test: (p: PlaybookInfo) => boolean }> = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'on', label: 'On', test: (p) => p.ok && !!p.enabled },
  { id: 'off', label: 'Off', test: (p) => p.ok && !p.enabled },
  { id: 'runbooks', label: 'Runbooks', test: (p) => p.kind === 'runbook' },
  { id: 'jev', label: 'Jev', test: (p) => !!p.usesJev },
  { id: 'problems', label: 'Problems', test: (p) => !p.ok || p.warnings.length > 0 }
]

function matches(p: PlaybookInfo, q: string): boolean {
  if (!q) return true
  const hay = [p.id, p.title, p.goal, p.when, p.ask, ...(p.said ?? []), ...(p.tags ?? []), ...(p.events ?? [])].filter(Boolean).join(' ').toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w))
}

function KindIcon({ p, size = 14 }: { p: PlaybookInfo; size?: number }) {
  const on = p.ok && p.enabled
  if (!p.ok) return <CircleAlert size={size} style={{ color: T.red, flexShrink: 0 }} />
  if (p.kind === 'runbook') return <ListChecks size={size} style={{ color: on ? T.cyan : T.text3, flexShrink: 0 }} />
  return <Workflow size={size} style={{ color: on ? T.violet : T.text3, flexShrink: 0 }} />
}

function Item({ p, active, dirty, onSelect, onToggle }: { p: PlaybookInfo; active: boolean; dirty: boolean; onSelect: () => void; onToggle: (on: boolean) => void }) {
  const on = p.ok && p.enabled
  const tint = p.kind === 'runbook' ? T.cyan : T.violet
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      data-playbook={p.id}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className="group relative flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left"
      style={{
        cursor: 'pointer',
        background: active ? alpha(tint, 12) : 'transparent',
        border: `1px solid ${active ? alpha(tint, 40) : 'transparent'}`,
        outline: 'none'
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = T.raised
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent'
      }}
    >
      <span className="mt-0.5">
        <KindIcon p={p} />
      </span>
      <span className="flex flex-col min-w-0 flex-1 gap-0.5">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm truncate" style={{ color: on ? T.text : T.text2, fontWeight: active ? 600 : 500 }}>
            {p.title ?? `${p.id}.md`}
          </span>
          {dirty && <span title="Unsaved changes" className="rounded-full shrink-0" style={{ width: 6, height: 6, background: T.amber }} />}
        </span>
        {p.ok ? (
          <span className="text-[11px] truncate" style={{ color: T.text3 }} title={triggerLine(p)}>
            {triggerLine(p)}
          </span>
        ) : (
          <span className="text-[11px] truncate" style={{ color: T.red }} title={p.errors.map(issueText).join('\n')}>
            {p.errors[0] ? issueText(p.errors[0]) : 'could not be read'}
          </span>
        )}
        {p.ok && (p.firedCount > 0 || p.warnings.length > 0 || p.usesJev || (p.priority && p.priority !== 'normal')) && (
          <span className="flex items-center gap-1.5 text-[10.5px] mt-0.5" style={{ color: T.text3 }}>
            {p.firedCount > 0 && (
              <span className="rounded px-1 py-px" style={{ background: T.greenTint, color: T.green }} title={`Last ${ago(p.lastFiredAt)}`}>
                fired {p.firedCount}×
              </span>
            )}
            {p.usesJev && (
              <span className="rounded px-1 py-px" style={{ background: T.violetTint, color: T.violet }}>
                Jev
              </span>
            )}
            {p.priority && p.priority !== 'normal' && (
              <span className="rounded px-1 py-px" style={{ background: T.raised, color: p.priority === 'critical' || p.priority === 'high' ? T.amber : T.text3 }}>
                {p.priority}
              </span>
            )}
            {p.warnings.length > 0 && (
              <span className="inline-flex items-center gap-0.5" style={{ color: T.amber }} title={p.warnings.map(issueText).join('\n')}>
                <AlertTriangle size={10} /> {p.warnings.length}
              </span>
            )}
          </span>
        )}
      </span>
      {p.ok && (
        <span onClick={(e) => e.stopPropagation()} className="shrink-0 mt-0.5" title={on ? 'On: click to switch it off' : 'Off: click to switch it on'}>
          <Toggle on={!!p.enabled} onChange={onToggle} />
        </span>
      )}
    </div>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
        <span className="text-[10.5px] font-semibold uppercase" style={{ color: T.text3, letterSpacing: '0.06em' }}>
          {title}
        </span>
        <span className="text-[10.5px]" style={{ color: T.text3, fontFamily: T.mono }}>
          {count}
        </span>
      </div>
      {children}
    </div>
  )
}

export function Sidebar({
  data,
  list,
  runs,
  selected,
  dirtyIds,
  newDraft,
  newActive,
  onSelectNew,
  onSelect,
  onToggle,
  onNew,
  onCancelRun,
  onOpenRun,
  triggersActive = false,
  onTriggers
}: {
  data: PlaybooksState | null
  list: PlaybookInfo[]
  runs: RunbookRun[]
  selected: string | null
  dirtyIds: string[]
  /** A new file being written, not saved yet: its kind. */
  newDraft: 'playbook' | 'runbook' | null
  newActive: boolean
  onSelectNew: () => void
  onSelect: (p: PlaybookInfo) => void
  onToggle: (p: PlaybookInfo, on: boolean) => void
  onNew: (kind: 'playbook' | 'runbook') => void
  onCancelRun: (runId: string) => void
  onOpenRun: (runbookId: string) => void
  /** The Triggers overview is open. */
  triggersActive?: boolean
  onTriggers?: () => void
}) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, list.filter(f.test).length])) as Record<Filter, number>, [list])
  const shown = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!
    return list.filter((p) => f.test(p) && matches(p, q.trim()))
  }, [list, filter, q])
  const playbooks = shown.filter((p) => p.ok && p.kind !== 'runbook')
  const runbooks = shown.filter((p) => p.ok && p.kind === 'runbook')
  const broken = shown.filter((p) => !p.ok)
  const active = runs.filter((r) => r.status === 'running' || r.status === 'waiting')
  const needJev = list.filter((p) => p.ok && p.enabled && p.usesJev).length
  const on = list.filter((p) => p.ok && p.enabled).length

  const item = (p: PlaybookInfo) => <Item key={p.id} p={p} active={selected === p.id} dirty={dirtyIds.includes(p.id)} onSelect={() => onSelect(p)} onToggle={(v) => onToggle(p, v)} />

  return (
    <aside className="flex flex-col min-h-0" style={{ width: 300, background: T.rail, borderRight: `1px solid ${T.border}`, flexShrink: 0 }}>
      <div className="flex flex-col gap-2.5 p-3" style={{ borderBottom: `1px solid ${T.border}` }}>
        <div className="flex gap-1.5">
          <div className="flex-1">
            <Btn small primary icon={Plus} onClick={() => onNew('playbook')}>
              Playbook
            </Btn>
          </div>
          <Btn small icon={Plus} onClick={() => onNew('runbook')}>
            Runbook
          </Btn>
          <Btn small icon={FolderOpen} onClick={() => void window.api.playbooks.openFolder()}>
            Folder
          </Btn>
        </div>
        {onTriggers && (
          <button
            type="button"
            onClick={onTriggers}
            aria-current={triggersActive ? 'true' : undefined}
            className="flex items-center gap-2 rounded-lg px-2.5 text-left"
            style={{ height: 34, cursor: 'pointer', background: triggersActive ? alpha(T.amber, 12) : T.bg, border: `1px solid ${triggersActive ? alpha(T.amber, 40) : T.border}` }}
          >
            <Zap size={14} style={{ color: T.amber, flexShrink: 0 }} />
            <span className="text-sm flex-1" style={{ color: T.text }}>Triggers</span>
            <span className="text-[11px]" style={{ color: T.text3 }}>
              {(() => {
                const fired = list.reduce((n, p) => n + p.firedCount, 0)
                return fired ? `${fired} fired` : 'overview'
              })()}
            </span>
            <ChevronRight size={13} style={{ color: T.text3 }} />
          </button>
        )}
        <div className="flex items-center gap-2 rounded-lg px-2.5" style={{ height: 32, background: T.bg, border: `1px solid ${T.border}` }}>
          <Search size={13} style={{ color: T.text3, flexShrink: 0 }} />
          <input
            aria-label="Search playbooks"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQ('')
            }}
            placeholder="Search names, phrases, tags…"
            className="flex-1 min-w-0 text-sm bg-transparent"
            style={{ border: 'none', outline: 'none', color: T.text }}
          />
          {q && (
            <button type="button" aria-label="Clear search" onClick={() => setQ('')} style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', display: 'inline-flex' }}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter">
          {FILTERS.filter((f) => f.id === 'all' || counts[f.id] > 0).map((f) => {
            const sel = filter === f.id
            const warn = f.id === 'problems'
            return (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={sel}
                onClick={() => setFilter(sel && f.id !== 'all' ? 'all' : f.id)}
                className="rounded-full px-2 py-0.5 text-[11px] inline-flex items-center gap-1"
                style={{
                  cursor: 'pointer',
                  background: sel ? (warn ? T.amberTint : T.cyanTint) : 'transparent',
                  color: sel ? (warn ? T.amber : T.cyan) : warn ? T.amber : T.text2,
                  border: `1px solid ${sel ? (warn ? alpha(T.amber, 50) : T.cyanBorder) : T.border}`
                }}
              >
                {f.label}
                <span style={{ opacity: 0.7, fontFamily: T.mono }}>{counts[f.id]}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="va-scroll flex-1 overflow-y-auto px-1.5 pb-3 flex flex-col gap-1">
        {active.length > 0 && (
          <div className="mx-1 mt-2 rounded-lg p-2 flex flex-col gap-1.5" style={{ background: T.cyanTint, border: `1px solid ${T.cyanBorder}` }}>
            <span className="text-[10.5px] font-semibold uppercase px-0.5" style={{ color: T.cyan, letterSpacing: '0.06em' }}>
              Running now
            </span>
            {active.map((r) => {
              const st = RUN_STATUS[r.status]
              return (
                <div key={r.runId} className="flex items-center gap-2 text-xs">
                  <span className={`rounded-full shrink-0 ${r.status === 'running' ? 'va-pulse' : ''}`} style={{ width: 7, height: 7, background: st.color }} />
                  <button type="button" onClick={() => onOpenRun(r.runbookId)} className="flex flex-col min-w-0 flex-1 text-left" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                    <span className="truncate" style={{ color: T.text, fontWeight: 500 }}>
                      {r.title}
                    </span>
                    <span className="truncate text-[11px]" style={{ color: st.color }}>
                      {st.label} · step {r.steps}
                    </span>
                  </button>
                  <button type="button" onClick={() => onCancelRun(r.runId)} aria-label={`Cancel ${r.title}`} title="Cancel this run" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', display: 'inline-flex' }}>
                    <X size={13} />
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {needJev > 0 && data && data.jev !== 'ready' && (
          <div className="mx-1 mt-2 flex items-start gap-2 text-[11.5px] rounded-lg px-2.5 py-2" style={{ background: T.amberTint, color: T.text, lineHeight: 1.45 }}>
            <AlertTriangle size={12} style={{ color: T.amber, flexShrink: 0, marginTop: 2 }} />
            <span>
              {needJev} {needJev === 1 ? 'needs' : 'need'} Jev to fire, and{' '}
              {data.jev === 'off' ? 'asking Jev is switched off (Settings > Tuning > Playbooks).' : 'there is no TypeSafe key yet (Settings > Providers).'} Until then they never fire; the rest work as normal.
            </span>
          </div>
        )}

        {newDraft && (
          <button
            type="button"
            onClick={onSelectNew}
            className="mx-1 mt-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left"
            style={{ cursor: 'pointer', background: newActive ? T.cyanTint : 'transparent', border: `1px dashed ${T.cyanBorder}` }}
          >
            <Plus size={14} style={{ color: T.cyan }} />
            <span className="text-sm font-medium" style={{ color: T.text }}>
              New {newDraft}, not saved yet
            </span>
          </button>
        )}

        <Group title="Playbooks" count={playbooks.length}>
          {playbooks.map(item)}
        </Group>
        <Group title="Runbooks" count={runbooks.length}>
          {runbooks.map(item)}
        </Group>
        <Group title="Can’t be read" count={broken.length}>
          {broken.map(item)}
        </Group>

        {list.length > 0 && shown.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Search size={18} style={{ color: T.text3 }} />
            <span className="text-xs" style={{ color: T.text3, lineHeight: 1.5 }}>
              Nothing matches{q ? ` “${q}”` : ''}
              {filter !== 'all' ? ` in ${FILTERS.find((f) => f.id === filter)!.label}` : ''}.
            </span>
            <Btn
              small
              onClick={() => {
                setQ('')
                setFilter('all')
              }}
            >
              Show everything
            </Btn>
          </div>
        )}
      </div>

      <div className="px-3 py-2 text-[11px] flex items-center gap-2" style={{ color: T.text3, borderTop: `1px solid ${T.border}` }} title={data?.dir}>
        <span>
          {list.filter((p) => p.ok).length} loaded · {on} on
        </span>
        {list.some((p) => !p.ok) && <span style={{ color: T.red }}>· {list.filter((p) => !p.ok).length} broken</span>}
      </div>
    </aside>
  )
}
