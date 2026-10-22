/**
 * Your other Claude Code sessions on this machine (terminal, IDE, other apps): search them, read any
 * transcript in the same rich timeline, and continue one here so it can be steered by voice.
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, FolderGit2, GitBranch, History, RefreshCw, Search, ShieldAlert, X } from 'lucide-react'
import type { CcEvent, CcExternal } from '@shared/claude'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Btn } from '../../components/primitives'
import { Activity } from './Activity'
import { ClaudeMark } from './ClaudeMark'
import { ago, fmtBytes } from './feed'

const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** Load the machine's saved sessions once per open; `null` while loading. */
export function useExternalSessions(open: boolean) {
  const [list, setList] = useState<CcExternal[] | null>(null)
  const [nonce, setNonce] = useState(0)
  const available = typeof window.api.claude?.external === 'function'
  useEffect(() => {
    if (!open || !available) return
    let live = true
    setList(null)
    window.api.claude.external().then((l) => { if (live) setList(l) }, () => { if (live) setList([]) })
    return () => { live = false }
  }, [open, available, nonce])
  return { list, available, reload: () => setNonce((n) => n + 1) }
}

function Transcript({ x, onAttached }: { x: CcExternal; onAttached: (id: string) => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const [events, setEvents] = useState<CcEvent[] | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    setEvents(null)
    window.api.claude.externalEvents(x.sessionId, x.cwd).then((e) => { if (live) setEvents(e) }, () => { if (live) setEvents([]) })
    return () => { live = false }
  }, [x.sessionId, x.cwd])
  const attach = async () => {
    setBusy(true)
    const r = await window.api.claude.attach({ sessionId: x.sessionId, title: x.title, cwd: x.cwd })
    setBusy(false)
    if (!r.ok) return pushToast('error', r.error)
    pushToast('info', `${r.session.name} is now in your sessions`)
    onAttached(r.session.id)
  }
  const prompts = events?.filter((e) => e.kind === 'user').length ?? 0
  const tools = events?.filter((e) => e.kind === 'tool').length ?? 0
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-start gap-3 px-5 py-3.5" style={{ borderBottom: `1px solid ${T.border}`, background: 'linear-gradient(180deg, rgba(217,119,87,.07), transparent)' }}>
        <div className="flex items-center justify-center rounded-xl" style={{ width: 40, height: 40, background: 'rgba(217,119,87,.10)', border: '1px solid rgba(217,119,87,.25)', flexShrink: 0 }}>
          <ClaudeMark size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold truncate" style={{ color: T.text }}>{x.title}</div>
          <div className="flex items-center gap-3 text-xs flex-wrap" style={{ color: T.text3 }}>
            <span className="inline-flex items-center gap-1" style={{ fontFamily: T.mono }} title={x.cwd}><FolderGit2 size={11} />{x.cwd}</span>
            {x.branch && x.branch !== 'HEAD' && <span className="inline-flex items-center gap-1"><GitBranch size={11} />{x.branch}</span>}
            <span>{ago(x.lastModified)}</span>
            {events && <span>{prompts} prompts · {tools} tool calls</span>}
          </div>
        </div>
        <Btn small primary icon={ArrowRight} disabled={busy} onClick={() => void attach()}>{busy ? 'Bringing it in…' : 'Continue here'}</Btn>
      </div>
      <div className="flex items-start gap-2 mx-5 mt-3 rounded-lg px-3 py-2 text-xs" style={{ background: T.amberTint, border: '1px solid rgba(255,180,84,.35)', color: T.text2, lineHeight: 1.55 }}>
        <ShieldAlert size={13} style={{ color: T.amber, flexShrink: 0, marginTop: 2 }} />
        <span>
          <b style={{ color: T.amber, fontWeight: 500 }}>Continue here</b> works in this session's real project folder, not a sandbox. It can edit files in{' '}
          <span style={{ fontFamily: T.mono }}>{base(x.cwd)}</span>; deleting, anything outside that folder, and pushing are blocked, and every shell command asks you
          first. It continues a copy, so the original session (and your terminal) is left as it was.
        </span>
      </div>
      {events === null ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-sm" style={{ color: T.text3 }}>
          <ClaudeMark size={18} working /> Reading the transcript…
        </div>
      ) : (
        <Activity events={events} running={false} waiting={false} since={null} workspace={x.cwd} />
      )}
    </div>
  )
}

export function Browse({ onClose, onAttached }: { onClose: () => void; onAttached: (id: string) => void }) {
  const { list, available, reload } = useExternalSessions(true)
  const [q, setQ] = useState('')
  const [project, setProject] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const projects = useMemo(() => {
    const m = new Map<string, number>()
    for (const x of list ?? []) m.set(x.cwd.toLowerCase(), (m.get(x.cwd.toLowerCase()) ?? 0) + 1)
    return [...m].sort((a, b) => b[1] - a[1]).map(([cwd, n]) => ({ cwd, n, name: base(list!.find((x) => x.cwd.toLowerCase() === cwd)!.cwd) }))
  }, [list])
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (list ?? []).filter((x) => (!project || x.cwd.toLowerCase() === project) && (!s || `${x.title} ${x.cwd} ${x.branch ?? ''}`.toLowerCase().includes(s)))
  }, [list, q, project])
  const current = shown.find((x) => x.sessionId === picked) ?? null

  if (!available) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="rounded-xl p-5" style={{ maxWidth: 440, background: T.amberTint, border: `1px solid ${T.amber}` }}>
          <div className="text-sm font-medium" style={{ color: T.amber }}>Restart the app to browse your other sessions</div>
          <div className="text-xs mt-1" style={{ color: T.text2 }}>The running app was started before this existed. Close it and run <code style={{ fontFamily: T.mono }}>pnpm dev</code> again.</div>
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-1 min-w-0">
      <div className="flex flex-col" style={{ width: 380, borderRight: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div className="px-4 pt-4 pb-3 flex flex-col gap-3" style={{ borderBottom: `1px solid ${T.border}` }}>
          <div className="flex items-center gap-2">
            <History size={16} style={{ color: '#D97757' }} />
            <span className="text-sm font-semibold flex-1" style={{ color: T.text }}>Your Claude Code sessions</span>
            <button type="button" aria-label="Reload sessions" onClick={reload} className="p-1 rounded-md" style={{ color: T.text3, cursor: 'pointer', background: 'transparent' }}><RefreshCw size={13} /></button>
            <button type="button" aria-label="Close browser" onClick={onClose} className="p-1 rounded-md" style={{ color: T.text3, cursor: 'pointer', background: 'transparent' }}><X size={14} /></button>
          </div>
          <div className="text-xs" style={{ color: T.text3, lineHeight: 1.5 }}>From your terminal, IDE and other apps on this computer. Read any of them, or continue one here and steer it by voice.</div>
          <div className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
            <Search size={12} style={{ color: T.text3 }} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, projects, branches" className="flex-1 text-xs" style={{ background: 'transparent', color: T.text, border: 'none' }} />
          </div>
          {projects.length > 1 && (
            <div className="flex gap-1.5 flex-wrap">
              <button type="button" onClick={() => setProject(null)} className="text-xs rounded-full px-2.5 py-0.5" style={{ cursor: 'pointer', background: !project ? 'rgba(217,119,87,.15)' : T.surface, color: !project ? '#E8A58C' : T.text3, border: `1px solid ${!project ? 'rgba(217,119,87,.4)' : T.border}` }}>
                All {list?.length}
              </button>
              {projects.slice(0, 8).map((p) => (
                <button key={p.cwd} type="button" onClick={() => setProject(project === p.cwd ? null : p.cwd)} className="text-xs rounded-full px-2.5 py-0.5" style={{ cursor: 'pointer', background: project === p.cwd ? 'rgba(217,119,87,.15)' : T.surface, color: project === p.cwd ? '#E8A58C' : T.text3, border: `1px solid ${project === p.cwd ? 'rgba(217,119,87,.4)' : T.border}` }}>
                  {p.name} {p.n}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="va-scroll flex-1 overflow-y-auto p-2 flex flex-col gap-1">
          {list === null && <div className="text-xs p-4 flex items-center gap-2" style={{ color: T.text3 }}><ClaudeMark size={14} working /> Looking for sessions…</div>}
          {list && shown.length === 0 && <div className="text-xs p-4" style={{ color: T.text3 }}>{list.length ? 'Nothing matches.' : 'No other Claude Code sessions found on this computer.'}</div>}
          {shown.map((x) => {
            const on = x.sessionId === current?.sessionId
            return (
              <button
                key={x.sessionId}
                type="button"
                onClick={() => setPicked(x.sessionId)}
                className="va-tree-row text-left rounded-lg px-3 py-2 flex flex-col gap-1"
                style={{ cursor: 'pointer', background: on ? 'rgba(217,119,87,.10)' : 'transparent', boxShadow: on ? 'inset 2px 0 0 #D97757' : undefined }}
              >
                <span className="text-sm truncate" style={{ color: on ? T.text : T.text2 }}>{x.title}</span>
                <span className="flex items-center gap-2 text-xs" style={{ color: T.text3 }}>
                  <span className="inline-flex items-center gap-1 truncate"><FolderGit2 size={11} />{base(x.cwd)}</span>
                  {x.branch && x.branch !== 'HEAD' && <span className="inline-flex items-center gap-1 truncate"><GitBranch size={11} />{x.branch}</span>}
                  <span className="ml-auto" style={{ flexShrink: 0 }}>{ago(x.lastModified)}</span>
                  {x.size ? <span style={{ fontFamily: T.mono, fontSize: 10.5, flexShrink: 0 }}>{fmtBytes(x.size)}</span> : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {current ? (
        <Transcript key={current.sessionId} x={current} onAttached={onAttached} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: T.text3 }}>
          <History size={36} style={{ opacity: 0.35 }} />
          <div className="text-sm">Pick a session to read it.</div>
          <div className="text-xs">Or just ask: “what were my other Claude sessions about?”</div>
        </div>
      )}
    </div>
  )
}
