import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Check, Octagon, Play, Plus, Send, Square, X, Zap } from 'lucide-react'
import type { CcAnswer, CcEvent, CcPending, CcQuestion, CcSession } from '@shared/claude'
import type { ClaudeSettings } from '@shared/types'
import { T } from '../theme'
import { useStore } from '../state/store'
import { statusColor, statusLabel, waitingOnUser } from '../state/claude'
import { Btn, Card, Dot, Empty, Page, SectionTitle, Tag, TextInput, Toggle } from '../components/primitives'

const KIND_STYLE: Record<CcEvent['kind'], { label: string; color: string }> = {
  user: { label: 'you', color: T.cyan },
  text: { label: '', color: T.text },
  tool: { label: 'tool', color: T.violet },
  tool_result: { label: 'result', color: T.text3 },
  denied: { label: 'blocked', color: T.red },
  result: { label: 'done', color: T.green },
  error: { label: 'error', color: T.red },
  status: { label: '', color: T.text3 },
  interrupt: { label: 'stopped', color: T.amber }
}

function useAnswer(id: string) {
  const pushToast = useStore((s) => s.pushToast)
  return async (answer: CcAnswer) => {
    const r = await window.api.claude.answer(id, answer)
    if (!r.ok) pushToast('error', r.error)
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
          <code className="text-xs rounded-lg p-2.5 break-all" style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono }}>{pending.summary}</code>
          <div className="flex gap-1.5">
            <Btn small primary icon={Check} onClick={() => void answer({ kind: 'allow' })}>Approve</Btn>
            <Btn small danger icon={Ban} onClick={() => void answer({ kind: 'deny' })}>Deny</Btn>
          </div>
        </div>
      )}
    </Card>
  )
}

function OutputLog({ events }: { events: CcEvent[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events])
  return (
    <div
      ref={ref}
      onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}
      className="va-scroll flex-1 overflow-y-auto rounded-xl p-3 flex flex-col gap-1"
      style={{ background: T.bg, border: `1px solid ${T.border}`, minHeight: 160, fontSize: 12.5, lineHeight: 1.5 }}
    >
      {events.length === 0 && <Empty>Nothing yet. Give it a task by voice or below.</Empty>}
      {events.map((e, i) => {
        const k = KIND_STYLE[e.kind]
        return (
          <div key={`${e.t}-${i}`} className="flex gap-2">
            <span style={{ color: k.color, minWidth: 54, fontFamily: T.mono, fontSize: 11, paddingTop: 1 }}>{k.label}</span>
            <span style={{ color: e.kind === 'tool' ? T.text2 : k.color, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: e.kind === 'tool' ? T.mono : undefined }}>{e.text}</span>
          </div>
        )
      })}
    </div>
  )
}

function Detail({ session }: { session: CcSession }) {
  const events = useStore((s) => s.claudeOutput[session.id]) ?? []
  const pushToast = useStore((s) => s.pushToast)
  const [text, setText] = useState('')
  const busy = session.status === 'running' || session.status === 'needs_input' || session.status === 'needs_permission'
  const check = async <T extends { ok: boolean }>(p: Promise<T>) => {
    const r = (await p) as { ok: boolean; error?: string }
    if (!r.ok) pushToast('error', r.error ?? 'Failed')
  }
  const send = (now: boolean) => {
    const t = text.trim()
    if (!t) return
    setText('')
    void check(window.api.claude.send(session.id, t, now))
  }
  return (
    <div className="flex-1 min-w-0 flex flex-col gap-3 p-5 overflow-hidden">
      <div className="flex items-center gap-3">
        <Dot color={statusColor(session.status, T)} pulse={session.status === 'running'} size={9} />
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold truncate" style={{ color: T.text }}>{session.name}</div>
          <div className="text-xs truncate" style={{ color: T.text3, fontFamily: T.mono }} title={session.workspace}>{session.workspace}</div>
        </div>
        <Tag>{statusLabel(session.status)}</Tag>
        <span className="text-xs" style={{ color: T.text3 }}>${session.costUsd.toFixed(3)}</span>
        <Btn small danger icon={Octagon} disabled={!busy} onClick={() => void check(window.api.claude.interrupt(session.id, false))}>Interrupt</Btn>
        <Btn small icon={Square} disabled={session.status === 'stopped'} onClick={() => void check(window.api.claude.stop(session.id))}>Stop</Btn>
      </div>

      {session.pending && <PendingCard session={session} pending={session.pending} />}

      <OutputLog events={events} />

      {session.queued.length > 0 && (
        <div className="flex flex-col gap-1">
          <SectionTitle>Queued ({session.queued.length}) · runs in order when the current task finishes</SectionTitle>
          {session.queued.map((q, i) => (
            <div key={`${i}-${q}`} className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm" style={{ background: T.surface, border: `1px solid ${T.border}`, color: T.text2 }}>
              <span style={{ color: T.text3, fontFamily: T.mono }}>{i + 1}</span>
              <span className="flex-1 truncate">{q}</span>
              <button type="button" aria-label="Remove queued prompt" onClick={() => void check(window.api.claude.dequeue(session.id, i))} style={{ color: T.text3, cursor: 'pointer' }}><X size={14} /></button>
            </div>
          ))}
        </div>
      )}

      <form className="flex gap-1.5 items-end" onSubmit={(e) => { e.preventDefault(); send(false) }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(false) } }}
          rows={2}
          placeholder={busy ? 'Add to the queue, or switch it to something else…' : 'Tell this session what to do…'}
          className="flex-1 rounded-lg p-2.5 text-sm resize-none"
          style={{ background: T.surface, color: T.text, border: `1px solid ${T.border}` }}
        />
        <Btn small primary type="submit" icon={Send} disabled={!text.trim()}>{busy ? 'Queue' : 'Send'}</Btn>
        {busy && <Btn small icon={Zap} disabled={!text.trim()} onClick={() => send(true)}>Send now</Btn>}
      </form>
    </div>
  )
}

function NewSession({ onDone }: { onDone: () => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const selectClaude = useStore((s) => s.selectClaude)
  const [name, setName] = useState('')
  const [task, setTask] = useState('')
  const go = async () => {
    const r = await window.api.claude.start(name.trim(), task.trim() || undefined)
    if (!r.ok) return pushToast('error', r.error)
    selectClaude(r.session.id)
    onDone()
  }
  return (
    <Card pad={12} className="flex flex-col gap-2">
      <TextInput value={name} onChange={setName} placeholder="Session name, e.g. landing page" autoFocus />
      <textarea value={task} onChange={(e) => setTask(e.target.value)} rows={3} placeholder="First task (optional)" className="w-full rounded-lg p-2 text-sm resize-none" style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}` }} />
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
  ['“Shut down landing page.”', 'Stops it; send it anything later to resume.']
]

function HowTo({ root }: { root: string }) {
  return (
    <Card pad={16} className="flex flex-col gap-3">
      <div className="text-sm font-medium" style={{ color: T.text }}>How it works</div>
      <div className="text-xs" style={{ color: T.text2, lineHeight: 1.6 }}>
        Turn on <b style={{ color: T.violet }}>Claude</b> (button next to Voice in chat, or here). Then just talk: the voice agent starts and steers Claude Code sessions for you,
        reads out their questions, and tells you when they finish. Each session can only touch its own folder inside <code style={{ fontFamily: T.mono, color: T.text }}>{root}</code>.
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

  return (
    <div className="flex flex-1 min-w-0">
      <aside className="flex flex-col gap-2 p-3 overflow-y-auto va-scroll" style={{ width: 290, background: T.rail, borderRight: `1px solid ${T.border}` }}>
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-medium" style={{ color: T.text }}>Sessions</span>
          <Btn small icon={Plus} onClick={() => setCreating(true)}>New</Btn>
        </div>
        {waiting.length > 0 && (
          <div className="rounded-lg px-3 py-2 text-xs" style={{ background: T.amberTint, color: T.amber, border: `1px solid ${T.amber}` }}>
            {waiting.length} waiting on you
          </div>
        )}
        {creating && <NewSession onDone={() => setCreating(false)} />}
        {sessions.length === 0 && !creating && <Empty>No sessions yet. Say “start a session called landing page” or tap New.</Empty>}
        {sessions.map((s) => (
          <Card key={s.id} pad={10} active={s.id === current?.id} onClick={() => selectClaude(s.id)} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Dot color={statusColor(s.status, T)} pulse={s.status === 'running' || !!s.pending} />
              <span className="text-sm font-medium truncate flex-1" style={{ color: T.text }}>{s.name}</span>
              {s.queued.length > 0 && <span className="text-xs" style={{ color: T.text3 }}>+{s.queued.length}</span>}
            </div>
            <div className="text-xs truncate" style={{ color: s.pending ? T.amber : T.text3 }}>
              {s.pending ? (s.pending.kind === 'question' ? 'Asking: ' : '') + s.pending.summary : s.lastSummary || statusLabel(s.status)}
            </div>
          </Card>
        ))}
        <div className="flex-1" />
        <button type="button" className="text-xs flex items-center gap-1 px-1" style={{ color: T.text3, cursor: 'pointer' }} onClick={() => setShowSettings(!showSettings)}>
          {showSettings ? 'Hide settings' : 'Settings'}
        </button>
        {showSettings && <ClaudeSettingsCard s={settings.claude} />}
      </aside>
      {current ? (
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
