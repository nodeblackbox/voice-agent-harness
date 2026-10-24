import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Ban, Check, Code, Coins, Copy, Ellipsis, Eye, FileCode, FolderGit2, FolderOpen, FolderTree, History, ListChecks, Octagon, Pencil, Play, Plus, RotateCcw, Send,
  Square, Trash2, Wrench, X, Zap, type LucideIcon
} from 'lucide-react'
import type { CcAnswer, CcEvent, CcPending, CcQuestion, CcSession } from '@shared/claude'
import type { ClaudeSettings } from '@shared/types'
import { T } from '../theme'
import { useStore } from '../state/store'
import { statusColor, statusLabel, waitingOnUser } from '../state/claude'
import { Btn, Card, Dot, Empty, Page, SectionTitle, Tag, TextInput, Toggle } from '../components/primitives'
import { AccountBadge, costNote, useClaudeAccount } from './claude/Account'
import { Activity as ActivityFeed } from './claude/Activity'
import { Browse } from './claude/Browse'
import { ClaudeMark, CLAUDE_ORANGE } from './claude/ClaudeMark'
import { Files, RestartNotice, useWorkspaceFiles } from './claude/Files'
import { Inspector } from './claude/Inspector'
import { Preview } from './claude/Preview'
import { ago, isHtml, touchedFiles, turnStart } from './claude/feed'

const EMPTY: CcEvent[] = []
const isBusy = (s: CcSession) => s.status === 'running' || s.status === 'needs_input' || s.status === 'needs_permission'

function useAnswer(id: string) {
  const pushToast = useStore((s) => s.pushToast)
  return async (answer: CcAnswer) => {
    const r = await window.api.claude.answer(id, answer)
    if (!r.ok) pushToast('error', r.error)
  }
}

/** Run a session action and toast its error, if any. */
function useCheck() {
  const pushToast = useStore((s) => s.pushToast)
  return async (p: Promise<{ ok: boolean; error?: string }>) => {
    const r = await p
    if (!r.ok) pushToast('error', r.error ?? 'Failed')
    return r.ok
  }
}

function QuestionCard({ id, q, count }: { id: string; q: CcQuestion; count: number }) {
  const answer = useAnswer(id)
  const [picked, setPicked] = useState<number[]>([])
  const [text, setText] = useState('')
  const single = count === 1
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {q.header && <Tag>{q.header}</Tag>}
        <span className="text-sm" style={{ color: T.text }}>{q.question}</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {q.options.map((o, i) => {
          const n = i + 1
          const on = picked.includes(n)
          return (
            <button
              key={o.label}
              type="button"
              onClick={() => (q.multiSelect ? setPicked(on ? picked.filter((x) => x !== n) : [...picked, n]) : single ? void answer({ kind: 'choice', choices: [n] }) : setPicked([n]))}
              className="text-left rounded-lg px-3 py-2 text-sm"
              style={{ background: on ? T.cyanTint : T.bg, border: `1px solid ${on ? T.cyanBorder : T.border}`, color: T.text, cursor: 'pointer' }}
            >
              <span style={{ color: T.amber, fontFamily: T.mono }}>{n}</span> {o.label}
              {o.description && <span style={{ color: T.text3 }}> — {o.description}</span>}
            </button>
          )
        })}
      </div>
      {(q.multiSelect || !single) && (
        <div>
          <Btn small primary icon={Check} disabled={!picked.length} onClick={() => void answer({ kind: 'choice', choices: picked })}>Confirm choice</Btn>
        </div>
      )}
      {single && (
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void answer({ kind: 'text', text: text.trim() }) }}>
          <TextInput value={text} onChange={setText} placeholder="Or type something else…" />
          <Btn small type="submit" icon={Send} disabled={!text.trim()}>Send</Btn>
        </form>
      )}
    </div>
  )
}

function PendingCard({ session, pending }: { session: CcSession; pending: CcPending }) {
  const answer = useAnswer(session.id)
  return (
    <Card pad={14} style={{ background: T.amberTint, border: `1px solid ${T.amber}` }}>
      <div className="flex items-center gap-2 mb-2">
        <Dot color={T.amber} pulse />
        <span className="text-sm font-medium" style={{ color: T.amber }}>
          {pending.kind === 'question' ? 'Needs your answer' : 'Needs your approval'}
        </span>
        <span className="text-xs" style={{ color: T.text3 }}>say it, or tap</span>
      </div>
      {pending.kind === 'question' ? (
        <div className="flex flex-col gap-4">
          {pending.questions.map((q) => <QuestionCard key={q.question} id={session.id} q={q} count={pending.questions.length} />)}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="va-term rounded-lg px-3 py-2 text-xs break-all" style={{ border: `1px solid ${T.border}`, color: '#E6EDF3' }}>
            <span style={{ color: T.green }}>{pending.toolName === 'PowerShell' ? 'PS> ' : '$ '}</span>
            {pending.summary.replace(/^Run:\s*/, '')}
          </div>
          <div className="flex gap-1.5">
            <Btn small primary icon={Check} onClick={() => void answer({ kind: 'allow' })}>Approve</Btn>
            <Btn small danger icon={Ban} onClick={() => void answer({ kind: 'deny' })}>Deny</Btn>
          </div>
        </div>
      )}
    </Card>
  )
}

function StatusPill({ status }: { status: CcSession['status'] }) {
  const c = statusColor(status, T)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs" style={{ background: `${c}17`, color: c, border: `1px solid ${c}40`, flexShrink: 0 }}>
      <Dot color={c} size={6} pulse={status === 'running' || status === 'needs_input' || status === 'needs_permission'} />
      {statusLabel(status)}
    </span>
  )
}

function SessionMenu({ session, onClose }: { session: CcSession; onClose: () => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const check = useCheck()
  const [confirm, setConfirm] = useState<'reset' | 'remove' | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose() }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [onClose])
  const run = (p: Promise<{ ok: boolean; error?: string }>) => { void check(p); onClose() }
  const item = (Icon: LucideIcon, title: string, sub: string, onClick: () => void, color: string = T.text) => (
    <button type="button" onClick={onClick} className="va-tree-row w-full flex items-start gap-2.5 px-3 py-2 text-left" style={{ cursor: 'pointer', background: 'transparent' }}>
      <Icon size={14} style={{ color, marginTop: 2, flexShrink: 0 }} />
      <span className="flex flex-col min-w-0">
        <span className="text-sm" style={{ color }}>{title}</span>
        <span className="text-xs truncate" style={{ color: T.text3 }}>{sub}</span>
      </span>
    </button>
  )
  return (
    <div ref={ref} className="absolute rounded-xl shadow-2xl overflow-hidden va-fade py-1" style={{ top: 'calc(100% + 6px)', right: 0, width: 280, background: T.raised, border: `1px solid ${T.border}`, zIndex: 40 }}>
      {item(FolderOpen, 'Open folder', 'In File Explorer', () => run(window.api.claude.open(session.id, '', 'default')))}
      {item(Code, 'Open in VS Code', 'Look at or edit the files yourself', () => run(window.api.claude.open(session.id, '', 'code')))}
      {item(Copy, 'Copy folder path', session.workspace, () => { void navigator.clipboard?.writeText(session.workspace); pushToast('info', 'Path copied'); onClose() })}
      <div style={{ height: 1, background: T.border, margin: '4px 0' }} />
      {confirm === 'reset'
        ? item(RotateCcw, 'Click again to start fresh', 'Forgets the conversation. Files stay.', () => run(window.api.claude.reset(session.id)), T.amber)
        : item(RotateCcw, 'Fresh start', 'New conversation, same folder', () => setConfirm('reset'))}
      {confirm === 'remove' ? (
        <>
          {item(Trash2, 'Remove, keep the folder', 'Off the list; files stay on disk', () => run(window.api.claude.remove(session.id)), T.red)}
          {!session.external && item(Trash2, 'Remove and delete the folder', `Deletes ${session.workspace.split(/[\\/]/).pop()} and its files for good`, () => run(window.api.claude.remove(session.id, true)), T.red)}
        </>
      ) : (
        item(Trash2, 'Remove session', session.external ? 'Take it off the list (your project folder is never deleted)' : 'Take it off the list, optionally deleting its folder', () => setConfirm('remove'), T.red)
      )}
    </div>
  )
}

function Header({ session, touched, toolCalls }: { session: CcSession; touched: number; toolCalls: number }) {
  const check = useCheck()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.name)
  const rename = () => {
    setEditing(false)
    if (name.trim() && name.trim() !== session.name) void check(window.api.claude.rename(session.id, name.trim()))
    else setName(session.name)
  }
  return (
    <div className="flex items-center gap-3 px-5 py-3.5" style={{ borderBottom: `1px solid ${T.border}`, background: 'linear-gradient(180deg, rgba(217,119,87,.07), transparent)' }}>
      <div className="flex items-center justify-center rounded-xl" style={{ width: 40, height: 40, background: 'rgba(217,119,87,.10)', border: '1px solid rgba(217,119,87,.25)', flexShrink: 0 }}>
        <ClaudeMark size={24} working={session.status === 'running'} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          {editing ? (
            <input
              autoFocus
              aria-label="Session name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={rename}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') { setName(session.name); setEditing(false) } }}
              className="text-base font-semibold rounded px-1"
              style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, minWidth: 0 }}
            />
          ) : (
            <button type="button" onClick={() => { setName(session.name); setEditing(true) }} title="Rename" className="group inline-flex items-center gap-1.5 min-w-0" style={{ cursor: 'text', background: 'transparent' }}>
              <span className="text-base font-semibold truncate" style={{ color: T.text }}>{session.name}</span>
              <Pencil size={11} className="opacity-0 group-hover:opacity-100" style={{ color: T.text3, flexShrink: 0 }} />
            </button>
          )}
          <StatusPill status={session.status} />
          {session.external && (
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs" title="Continued from one of your saved sessions: it works in this real project folder (fenced to it; shell commands always ask)" style={{ background: 'rgba(138,164,200,.10)', color: '#8AA4C8', border: '1px solid rgba(138,164,200,.3)', flexShrink: 0 }}>
              <FolderGit2 size={11} /> your project
            </span>
          )}
        </div>
        <button type="button" onClick={() => void check(window.api.claude.open(session.id, '', 'default'))} className="text-xs truncate block max-w-full text-left" style={{ color: T.text3, fontFamily: T.mono, cursor: 'pointer', background: 'transparent' }} title="Open folder">
          {session.workspace}
        </button>
      </div>
      <div className="hidden lg:flex items-center gap-3 text-xs" style={{ color: T.text3, fontFamily: T.mono }}>
        <span title={costNote(session)} className="inline-flex items-center gap-1"><Coins size={11} />${session.costUsd.toFixed(3)}</span>
        <span title="Files changed" className="inline-flex items-center gap-1"><FileCode size={11} />{touched}</span>
        <span title="Tool calls" className="inline-flex items-center gap-1"><Wrench size={11} />{toolCalls}</span>
      </div>
      <Btn small danger icon={Octagon} disabled={!isBusy(session)} onClick={() => void check(window.api.claude.interrupt(session.id, false))}>Interrupt</Btn>
      <Btn small icon={Square} disabled={session.status === 'stopped'} onClick={() => void check(window.api.claude.stop(session.id))}>Stop</Btn>
      <div className="relative">
        <button type="button" aria-label="More session actions" onClick={() => setMenu(!menu)} className="inline-flex items-center justify-center rounded-lg" style={{ width: 28, height: 26, background: menu ? T.raised : T.surface, border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer' }}>
          <Ellipsis size={14} />
        </button>
        {menu && <SessionMenu session={session} onClose={() => setMenu(false)} />}
      </div>
    </div>
  )
}

function Composer({ session }: { session: CcSession }) {
  const check = useCheck()
  const [text, setText] = useState('')
  const busy = isBusy(session)
  const send = (now: boolean) => {
    const t = text.trim()
    if (!t) return
    setText('')
    void check(window.api.claude.send(session.id, t, now))
  }
  return (
    <div className="px-4 pb-4 pt-2 flex flex-col gap-2" style={{ borderTop: `1px solid ${T.border}` }}>
      {session.queued.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionTitle>Queued ({session.queued.length}) · runs in order when the current task finishes</SectionTitle>
          {session.queued.map((q, i) => (
            <div key={`${i}-${q}`} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm va-fade" style={{ background: T.surface, border: `1px dashed ${T.border}`, color: T.text2 }}>
              <span className="inline-flex items-center justify-center rounded-full text-xs" style={{ width: 18, height: 18, background: T.raised, color: T.text3, fontFamily: T.mono, flexShrink: 0 }}>{i + 1}</span>
              <span className="flex-1 truncate">{q}</span>
              <button type="button" aria-label="Remove queued prompt" onClick={() => void check(window.api.claude.dequeue(session.id, i))} style={{ color: T.text3, cursor: 'pointer' }}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}
      <form className="flex gap-2 items-end rounded-xl p-2" style={{ background: T.surface, border: `1px solid ${busy ? 'rgba(217,119,87,.35)' : T.border}` }} onSubmit={(e) => { e.preventDefault(); send(false) }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(false) } }}
          rows={2}
          placeholder={busy ? 'Add to the queue, or switch it to something else…' : 'Tell this session what to do…'}
          className="flex-1 p-1.5 text-sm resize-none"
          style={{ background: 'transparent', color: T.text, border: 'none' }}
        />
        <div className="flex gap-1.5 items-end">
          {busy && <Btn small icon={Zap} disabled={!text.trim()} onClick={() => send(true)}>Send now</Btn>}
          <Btn small primary type="submit" icon={Send} disabled={!text.trim()}>{busy ? 'Queue' : 'Send'}</Btn>
        </div>
      </form>
    </div>
  )
}

type Tab = 'activity' | 'files' | 'preview'

function Detail({ session }: { session: CcSession }) {
  const events = useStore((s) => s.claudeOutput[session.id]) ?? EMPTY
  const [tab, setTab] = useState<Tab>('activity')
  const [file, setFile] = useState<string | null>(null)
  const [page, setPage] = useState<string | null>(null)
  const touched = useMemo(() => touchedFiles(events, session.workspace), [events, session.workspace])
  const toolCalls = useMemo(() => events.filter((e) => e.kind === 'tool').length, [events])
  // bumps whenever a tool finishes or a turn ends: the file tree and the preview refresh on it
  const pulse = useMemo(() => events.filter((e) => e.kind === 'tool_result' || e.kind === 'result').length, [events])
  const { files, refresh, unavailable } = useWorkspaceFiles(session.id, pulse)
  const openFile = (rel: string) => { setFile(rel); setTab('files') }
  const fileCount = (files ?? []).filter((f) => !f.dir).length
  const hasPage = (files ?? []).some((f) => !f.dir && isHtml(f.path))
  const tabs: Array<{ id: Tab; label: string; icon: LucideIcon; badge?: string }> = [
    { id: 'activity', label: 'Activity', icon: Activity, badge: toolCalls ? String(toolCalls) : undefined },
    { id: 'files', label: 'Files', icon: FolderTree, badge: unavailable ? '!' : files ? String(fileCount) : undefined },
    { id: 'preview', label: 'Preview', icon: Eye, badge: hasPage ? 'live' : undefined }
  ]
  return (
    <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
      <Header session={session} touched={touched.length} toolCalls={toolCalls} />
      {session.pending && <div className="px-5 pt-3"><PendingCard session={session} pending={session.pending} /></div>}
      <div className="flex items-center gap-1 px-4" style={{ borderBottom: `1px solid ${T.border}` }} role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className="inline-flex items-center gap-1.5 px-3 py-2.5 text-sm"
            style={{ color: tab === t.id ? T.text : T.text3, borderBottom: `2px solid ${tab === t.id ? CLAUDE_ORANGE : 'transparent'}`, marginBottom: -1, cursor: 'pointer', background: 'transparent' }}
          >
            <t.icon size={14} />
            {t.label}
            {t.badge && <span className="text-xs rounded-full px-1.5" style={{ background: t.badge === 'live' ? 'rgba(74,222,128,.12)' : T.raised, color: t.badge === 'live' ? T.green : T.text3 }}>{t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 flex">
        {tab === 'activity' && (
          <>
            <div className="flex-1 min-w-0 flex flex-col">
              <ActivityFeed events={events} running={isBusy(session)} waiting={!!session.pending} since={turnStart(events)} workspace={session.workspace} onOpenFile={openFile} />
            </div>
            <Inspector session={session} events={events} touched={touched} onOpenFile={openFile} />
          </>
        )}
        {tab === 'files' && (
          <Files
            id={session.id}
            workspace={session.workspace}
            files={files}
            refresh={() => void refresh()}
            unavailable={unavailable}
            touched={touched}
            selected={file}
            onSelect={setFile}
            onPreview={(rel) => { setPage(rel); setTab('preview') }}
          />
        )}
        {tab === 'preview' && (unavailable ? <RestartNotice what="the live preview" /> : <Preview id={session.id} files={files} page={page} onPage={setPage} pulse={pulse} />)}
      </div>
      <Composer session={session} />
    </div>
  )
}

function SessionCard({ s, active, picked, onClick }: { s: CcSession; active: boolean; picked?: boolean; onClick: () => void }) {
  const working = s.status === 'running'
  const c = statusColor(s.status, T)
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left rounded-xl p-3 flex flex-col gap-1.5 va-fade"
      style={{
        cursor: 'pointer',
        background: active ? T.raised : T.surface,
        border: `1px solid ${picked ? T.red : s.pending ? T.amber : active ? 'rgba(217,119,87,.45)' : T.border}`,
        opacity: picked === false ? 0.75 : 1,
        boxShadow: active ? '0 0 0 3px rgba(217,119,87,.08)' : undefined
      }}
    >
      <div className="flex items-center gap-2">
        {picked !== undefined && (
          <span className="inline-flex items-center justify-center rounded" style={{ width: 15, height: 15, border: `1px solid ${picked ? T.red : T.text3}`, background: picked ? T.red : 'transparent', flexShrink: 0 }}>
            {picked && <Check size={11} style={{ color: T.bg }} />}
          </span>
        )}
        <ClaudeMark size={16} working={working} color={s.status === 'stopped' ? T.text3 : undefined} />
        <span className="text-sm font-medium truncate flex-1" style={{ color: T.text }}>{s.name}</span>
        {s.external && <FolderGit2 size={12} style={{ color: '#8AA4C8', flexShrink: 0 }} aria-label="your project" />}
        <span className="text-xs inline-flex items-center gap-1" style={{ color: c, flexShrink: 0 }}>
          <Dot color={c} size={6} pulse={working || !!s.pending} />
          {statusLabel(s.status)}
        </span>
      </div>
      <div className="text-xs" style={{ color: s.pending ? T.amber : T.text3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.45 }}>
        {s.pending ? (s.pending.kind === 'question' ? 'Asking: ' : '') + s.pending.summary : s.lastSummary || (s.status === 'idle' ? 'Ready for a task' : statusLabel(s.status))}
      </div>
      <div className="flex items-center gap-1.5 text-xs" style={{ color: T.text3, fontFamily: T.mono, fontSize: 10.5 }}>
        <span title={costNote(s)}>${s.costUsd.toFixed(2)}</span>
        <span>·</span>
        <span>{s.turns} turns</span>
        <span>·</span>
        <span>{ago(s.updatedAt)}</span>
        {s.queued.length > 0 && <span className="ml-auto rounded-full px-1.5" style={{ background: T.bg, color: T.text2 }}>+{s.queued.length}</span>}
      </div>
    </button>
  )
}

type Folders = Array<{ name: string; path: string; mtime: number; inUse: boolean }>

function NewSession({ onDone, root }: { onDone: () => void; root: string }) {
  const pushToast = useStore((s) => s.pushToast)
  const selectClaude = useStore((s) => s.selectClaude)
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  // '' = a new sandbox folder; a folder name under the root; or a full path chosen with Browse
  const [folder, setFolder] = useState('')
  const [folders, setFolders] = useState<Folders>([])
  useEffect(() => {
    if (typeof window.api.claude.folders !== 'function') return
    void window.api.claude.folders().then(setFolders, () => setFolders([]))
  }, [])
  const outside = /^[a-z]:[\\/]|^[\\/]/i.test(folder) && !folder.toLowerCase().startsWith(root.toLowerCase())
  const browse = async () => {
    const p = await window.api.claude.pickFolder()
    if (p) setFolder(p)
  }
  const go = async () => {
    const r = await window.api.claude.start(name.trim(), task.trim() || undefined, folder || undefined)
    if (!r.ok) return pushToast('error', r.error)
    selectClaude(r.session.id)
    onDone()
  }
  const chip = (on: boolean) => ({ cursor: 'pointer', background: on ? 'rgba(217,119,87,.15)' : T.bg, color: on ? '#E8A58C' : T.text3, border: `1px solid ${on ? 'rgba(217,119,87,.4)' : T.border}` })
  return (
    <Card pad={12} className="flex flex-col gap-2" style={{ border: '1px solid rgba(217,119,87,.4)' }}>
      <TextInput value={name} onChange={setName} placeholder="Session name, e.g. landing page" autoFocus />
      <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="First task (optional)" className="w-full rounded-lg p-2 text-sm resize-none" style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}` }} />
      <div className="flex flex-col gap-1.5">
        <SectionTitle>Works in</SectionTitle>
        <div className="flex gap-1.5 flex-wrap">
          <button type="button" onClick={() => setFolder('')} className="text-xs rounded-full px-2.5 py-0.5" style={chip(!folder)}>New folder</button>
          {folders.slice(0, 6).map((f) => (
            <button key={f.path} type="button" onClick={() => setFolder(f.name)} title={f.inUse ? 'Another session works here too' : f.path} className="text-xs rounded-full px-2.5 py-0.5" style={chip(folder === f.name)}>
              {f.name}
              {f.inUse && <span style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 5, background: T.violet, marginLeft: 5, verticalAlign: 'middle' }} />}
            </button>
          ))}
          {typeof window.api.claude.pickFolder === 'function' && (
            <button type="button" onClick={() => void browse()} className="text-xs rounded-full px-2.5 py-0.5 inline-flex items-center gap-1" style={chip(outside)}>
              <FolderOpen size={11} /> Browse…
            </button>
          )}
        </div>
        {folder && (
          <div className="text-xs truncate" style={{ color: T.text3, fontFamily: T.mono }} title={folder}>
            {/^[a-z]:[\\/]|^[\\/]/i.test(folder) ? folder : `${root}\\${folder}`}
          </div>
        )}
        {outside && (
          <div className="text-xs rounded-lg px-2 py-1.5" style={{ background: T.amberTint, color: T.amber, lineHeight: 1.5 }}>
            Your real files: it can edit inside this folder (deleting, other folders and pushing stay blocked; every command asks you).
          </div>
        )}
      </div>
      <div className="flex gap-1.5 justify-end">
        <Btn small onClick={onDone} icon={X}>Cancel</Btn>
        <Btn small primary icon={Play} disabled={!name.trim()} onClick={() => void go()}>Start</Btn>
      </div>
    </Card>
  )
}

function ClaudeSettingsCard({ s }: { s: ClaudeSettings }) {
  const updateSettings = useStore((st) => st.updateSettings)
  const set = (patch: Partial<ClaudeSettings>) => void updateSettings({ claude: { ...s, ...patch } })
  return (
    <Card pad={14} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm" style={{ color: T.text }}>Voice control of Claude Code</div>
          <div className="text-xs" style={{ color: T.text3 }}>Lets the voice agent start, steer, interrupt and answer sessions.</div>
        </div>
        <Toggle on={s.enabled} onChange={(v) => set({ enabled: v })} />
      </div>
      <div className="flex flex-col gap-1">
        <SectionTitle>Workspace folder (sessions can only touch their own sub-folder of this)</SectionTitle>
        <TextInput value={s.workspaceRoot} onChange={(v) => set({ workspaceRoot: v })} />
      </div>
      <div className="flex items-center justify-between">
        <div className="text-sm" style={{ color: T.text }}>Ask before running shell commands</div>
        <Toggle on={s.approveShell} onChange={(v) => set({ approveShell: v })} />
      </div>
    </Card>
  )
}

const EXAMPLES: Array<[string, string]> = [
  ['“Start a session called landing page and build a one-page site for a bakery.”', 'Creates a sandboxed folder and gets Claude Code working.'],
  ['“Also add a contact form.”', 'Queued behind what it is doing now.'],
  ['“How is landing page going?”', 'A short spoken summary of what just happened.'],
  ['“The second one.” / “Yes, go ahead.”', 'Answers its question or approval when it asks you.'],
  ['“Hold on, stop that.”', 'Interrupts it; it keeps its context and can carry on.'],
  ['“What files did it make?”', 'Lists what is in its folder. The Files tab shows them all.'],
  ['“Start landing page over.”', 'Fresh conversation in the same folder.'],
  ['“Shut down landing page.”', 'Stops it; send it anything later to resume.']
]

function HowTo({ root }: { root: string }) {
  return (
    <Card pad={16} className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm font-medium" style={{ color: T.text }}>
        <ClaudeMark size={18} /> How it works
      </div>
      <div className="text-xs" style={{ color: T.text2, lineHeight: 1.6 }}>
        Turn on <b style={{ color: T.violet }}>Claude</b> (button next to Voice in chat, or here). Then just talk: the voice agent starts and steers Claude Code sessions for you,
        reads out their questions, and tells you when they finish. Watch each one work in <b style={{ color: T.text }}>Activity</b>, browse its folder in{' '}
        <b style={{ color: T.text }}>Files</b>, and see web pages it builds live in <b style={{ color: T.text }}>Preview</b>. Each session can only touch its own folder inside{' '}
        <code style={{ fontFamily: T.mono, color: T.text }}>{root}</code>.
      </div>
      <div className="flex flex-col gap-2">
        {EXAMPLES.map(([say, does]) => (
          <div key={say} className="flex flex-col">
            <span className="text-sm" style={{ color: T.cyan }}>{say}</span>
            <span className="text-xs" style={{ color: T.text3 }}>{does}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

export function ClaudeView() {
  const settings = useStore((s) => s.settings)
  const sessions = useStore((s) => s.claudeSessions)
  const selected = useStore((s) => s.claudeSelected)
  const selectClaude = useStore((s) => s.selectClaude)
  const reloadClaude = useStore((s) => s.reloadClaude)
  const [creating, setCreating] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [picking, setPicking] = useState<Set<string> | null>(null)
  const who = useClaudeAccount()
  const [deleteFolders, setDeleteFolders] = useState(false)
  const pushToast = useStore((s) => s.pushToast)
  const prune = async () => {
    if (!picking?.size) return
    const results = await Promise.all([...picking].map((id) => window.api.claude.remove(id, deleteFolders && !sessions.find((s) => s.id === id)?.external)))
    const failed = results.filter((x) => !x.ok)
    pushToast(failed.length ? 'warn' : 'info', failed.length ? `${results.length - failed.length} removed; ${(failed[0] as { error: string }).error}` : `Removed ${results.length} session${results.length > 1 ? 's' : ''}${deleteFolders ? ' and their folders' : ''}`)
    setPicking(null)
    setDeleteFolders(false)
  }

  useEffect(() => { void reloadClaude() }, [reloadClaude])
  const waiting = useMemo(() => waitingOnUser(sessions), [sessions])
  const current = sessions.find((s) => s.id === selected) ?? sessions[0]

  if (!settings) return null
  // The window reloads on its own during development, but the main process does not: an app started
  // before this feature existed has no Claude backend yet.
  if (!settings.claude || !window.api.claude) {
    return (
      <Page title="Claude Code" sub="Run several Claude Code sessions in the background and manage them with your voice.">
        <Card pad={16} style={{ background: T.amberTint, border: `1px solid ${T.amber}` }}>
          <div className="text-sm font-medium" style={{ color: T.amber }}>Restart the app to load Claude Code</div>
          <div className="text-xs mt-1" style={{ color: T.text2 }}>
            This window is newer than the running app. Close it and run <code style={{ fontFamily: T.mono }}>pnpm dev</code> again.
          </div>
        </Card>
      </Page>
    )
  }
  if (!settings.claude.enabled) {
    return (
      <Page title="Claude Code" sub="Run several Claude Code sessions in the background and manage them with your voice.">
        <ClaudeSettingsCard s={settings.claude} />
        <HowTo root={settings.claude.workspaceRoot} />
      </Page>
    )
  }

  const running = sessions.filter((s) => s.status === 'running').length
  return (
    <div className="flex flex-1 min-w-0">
      <aside className="flex flex-col gap-2 p-3 overflow-y-auto va-scroll" style={{ width: 280, background: T.rail, borderRight: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="inline-flex items-center gap-2 text-sm font-medium" style={{ color: T.text }}>
            <ClaudeMark size={16} working={running > 0} /> Sessions
          </span>
          <span className="flex gap-1">
            {sessions.length > 0 && <Btn small icon={picking ? X : ListChecks} onClick={() => { setPicking(picking ? null : new Set()); setDeleteFolders(false) }}>{picking ? 'Done' : 'Select'}</Btn>}
            {!picking && <Btn small icon={Plus} onClick={() => setCreating(true)}>New</Btn>}
          </span>
        </div>
        <AccountBadge {...who} />
        {sessions.length > 0 && (
          <div className="flex items-center gap-3 px-1 text-xs" style={{ color: T.text3 }}>
            <span>{sessions.length} total</span>
            {running > 0 && <span style={{ color: T.violet }}>{running} working</span>}
            <span className="ml-auto" title={costNote(null, who.account?.billing === 'subscription' ? who.account.plan ?? 'Claude' : undefined)} style={{ fontFamily: T.mono }}>${sessions.reduce((n, s) => n + s.costUsd, 0).toFixed(2)}</span>
          </div>
        )}
        {waiting.length > 0 && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: T.amberTint, color: T.amber, border: `1px solid ${T.amber}` }}>
            {waiting.length} waiting on you
          </div>
        )}
        {creating && <NewSession root={settings.claude.workspaceRoot} onDone={() => setCreating(false)} />}
        {sessions.length === 0 && !creating && <Empty>No sessions yet. Say “start a session called landing page” or tap New.</Empty>}
        {sessions.map((s) => (
          <SessionCard
            key={s.id}
            s={s}
            active={!picking && !browsing && s.id === current?.id}
            picked={picking ? picking.has(s.id) : undefined}
            onClick={() => {
              if (picking) {
                const n = new Set(picking)
                if (n.has(s.id)) n.delete(s.id)
                else n.add(s.id)
                setPicking(n)
              } else {
                setBrowsing(false)
                selectClaude(s.id)
              }
            }}
          />
        ))}
        {picking && (
          <div className="rounded-xl p-3 flex flex-col gap-2 va-fade" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
            <div className="flex gap-1.5">
              <Btn small onClick={() => setPicking(new Set(sessions.filter((x) => x.status === 'stopped' || x.status === 'idle').map((x) => x.id)))}>All not working</Btn>
              <Btn small onClick={() => setPicking(new Set())}>None</Btn>
            </div>
            <label className="flex items-center gap-2 text-xs" style={{ color: deleteFolders ? T.red : T.text2, cursor: 'pointer' }}>
              <input type="checkbox" checked={deleteFolders} onChange={(e) => setDeleteFolders(e.target.checked)} />
              Also delete their sandbox folders
            </label>
            <Btn small danger icon={Trash2} disabled={!picking.size} onClick={() => void prune()}>
              Remove {picking.size || ''} session{picking.size === 1 ? '' : 's'}
            </Btn>
          </div>
        )}
        <button
          type="button"
          onClick={() => setBrowsing(!browsing)}
          className="w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left mt-1"
          style={{ cursor: 'pointer', background: browsing ? 'rgba(217,119,87,.10)' : 'transparent', border: `1px dashed ${browsing ? 'rgba(217,119,87,.5)' : T.border}` }}
        >
          <History size={15} style={{ color: '#D97757', flexShrink: 0 }} />
          <span className="flex flex-col min-w-0">
            <span className="text-sm" style={{ color: T.text }}>Your other sessions</span>
            <span className="text-xs" style={{ color: T.text3 }}>From the terminal, IDE and other apps</span>
          </span>
        </button>
        <div className="flex-1" />
        <button type="button" className="text-xs flex items-center gap-1 px-1" style={{ color: T.text3, cursor: 'pointer' }} onClick={() => setShowSettings(!showSettings)}>
          {showSettings ? 'Hide settings' : 'Settings'}
        </button>
        {showSettings && <ClaudeSettingsCard s={settings.claude} />}
      </aside>
      {browsing ? (
        <Browse onClose={() => setBrowsing(false)} onAttached={(id) => { selectClaude(id); setBrowsing(false) }} />
      ) : current ? (
        <Detail key={current.id} session={current} />
      ) : (
        <div className="va-scroll flex-1 overflow-y-auto p-6">
          <div className="mx-auto" style={{ maxWidth: 640 }}>
            <HowTo root={settings.claude.workspaceRoot} />
          </div>
        </div>
      )}
    </div>
  )
}
