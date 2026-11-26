/**
 * Playbooks (docs/TRIGGERS.md): each one is a Markdown file whose header says when it applies and whose
 * body says what the assistant should do. The list shows what each one reacts to and how often it fired
 * this run; the editor works on the file text itself (the single source of truth), checks it as you type,
 * refuses to save a file that would not load, and can replay your recent messages to show which would
 * have set it off.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, CircleAlert, Copy, FlaskConical, FolderOpen, Plus, RotateCcw, Save, Trash2, Workflow } from 'lucide-react'
import type { PlaybookCheck, PlaybookInfo, PlaybookIssue, PlaybooksState, PlaybookTestRow } from '@shared/types'
import { T, alpha } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Empty, Page, Tag, Toggle } from '../components/primitives'

const CodeEditor = lazy(() => import('./claude/CodeEditor'))

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/

const NEW_PLAYBOOK = `---
kind: playbook
title: New playbook
goal: What this is for, in one sentence.
enabled: true
priority: normal
triggers:
  events: [turn.user]
  said: ["two or more words"]
gates:
  cooldownS: 0
tags: []
---
What the assistant should do in this situation, in plain words.
`

function ago(t: number | null, now = Date.now()): string {
  if (!t) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  return `${Math.round(s / 3600)} h ago`
}

function freeId(base: string, taken: string[]): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'playbook'
  if (!taken.includes(clean)) return clean
  for (let i = 2; ; i++) if (!taken.includes(`${clean}-${i}`)) return `${clean}-${i}`
}

function issueText(i: PlaybookIssue): string {
  return i.line ? `line ${i.line}: ${i.message}` : i.message
}

/** What a playbook reacts to, as short chips. */
function TriggerChips({ p }: { p: PlaybookInfo }) {
  const chips: Array<{ k: string; text: string; title: string }> = []
  if (p.when) chips.push({ k: 'when', text: p.when, title: 'condition' })
  if (p.ask) chips.push({ k: 'ask', text: `Jev: ${p.ask}`, title: 'a yes/no question Jev answers about the message' })
  for (const s of p.said ?? []) chips.push({ k: `said-${s}`, text: `“${s}”`, title: 'when you say these words' })
  const events = (p.events ?? []).filter((e) => e !== 'turn.user')
  for (const e of events) chips.push({ k: `ev-${e}`, text: e, title: 'event' })
  if (!chips.length) chips.push({ k: 'all', text: 'every message', title: 'no condition' })
  return (
    <div className="flex flex-wrap gap-1 min-w-0">
      {chips.map((c) => (
        <span key={c.k} title={`${c.title}: ${c.text}`} className="text-[11px] rounded px-1.5 py-0.5 truncate" style={{ maxWidth: '100%', background: T.raised, color: T.text2, fontFamily: T.mono }}>
          {c.text}
        </span>
      ))}
    </div>
  )
}

function ListItem({ p, active, onSelect, onToggle }: { p: PlaybookInfo; active: boolean; onSelect: () => void; onToggle: (on: boolean) => void }) {
  const on = p.ok && p.enabled
  return (
    <Card pad={12} active={active} onClick={onSelect} className="va-fade">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {p.ok ? <Workflow size={14} style={{ color: on ? T.violet : T.text3, flexShrink: 0 }} /> : <CircleAlert size={14} style={{ color: T.red, flexShrink: 0 }} />}
          <span className="text-sm font-medium truncate" style={{ color: on ? T.text : T.text2 }}>
            {p.title ?? `${p.id}.md`}
          </span>
        </div>
        {p.ok && (
          <span onClick={(e) => e.stopPropagation()}>
            <Toggle on={!!p.enabled} onChange={onToggle} />
          </span>
        )}
      </div>
      {p.ok ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <TriggerChips p={p} />
          <div className="flex items-center gap-1.5 text-xs" style={{ color: T.text3 }}>
            {p.usesJev && (
              <span className="text-[11px] rounded px-1.5 py-0.5" style={{ background: T.violetTint, color: T.violet }} title="Needs Jev's answer to fire">
                Jev
              </span>
            )}
            {p.priority && p.priority !== 'normal' && <Tag>{p.priority}</Tag>}
            <span>{p.firedCount ? `fired ${p.firedCount}× · ${ago(p.lastFiredAt)}` : 'not fired this run'}</span>
            {p.warnings.length > 0 && (
              <span className="inline-flex items-center gap-1" style={{ color: T.amber }} title={p.warnings.map(issueText).join('\n')}>
                <AlertTriangle size={11} /> {p.warnings.length}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-1.5 text-xs" style={{ color: T.red, lineHeight: 1.45 }}>
          Not loaded: {p.errors[0] ? issueText(p.errors[0]) : 'unreadable'}
        </div>
      )}
    </Card>
  )
}

function Issues({ check }: { check: PlaybookCheck | null }) {
  if (!check) return null
  const rows = [...check.errors.map((i) => ({ ...i, bad: true })), ...check.warnings.map((i) => ({ ...i, bad: false }))]
  if (!rows.length)
    return (
      <div className="flex items-center gap-1.5 text-xs" style={{ color: T.green }}>
        <Check size={12} /> The file loads without problems.
      </div>
    )
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs rounded-md px-2 py-1.5" style={{ background: r.bad ? T.redTint : T.amberTint, color: T.text, lineHeight: 1.45 }}>
          {r.bad ? <CircleAlert size={12} style={{ color: T.red, flexShrink: 0, marginTop: 2 }} /> : <AlertTriangle size={12} style={{ color: T.amber, flexShrink: 0, marginTop: 2 }} />}
          {r.line > 0 && (
            <span className="shrink-0" style={{ color: T.text3, fontFamily: T.mono }}>
              line {r.line}
            </span>
          )}
          <span>{r.message}</span>
        </div>
      ))}
    </div>
  )
}

function TestResults({ rows, note, onClose }: { rows: PlaybookTestRow[]; note?: string; onClose: () => void }) {
  const [all, setAll] = useState(false)
  const hits = rows.filter((r) => r.why)
  const shown = all ? rows : hits
  return (
    <div className="flex flex-col gap-2 rounded-lg p-3" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium" style={{ color: T.text2 }}>
          {rows.length ? `${hits.length} of your last ${rows.length} messages would have set it off` : 'No messages to test against yet'}
          <span style={{ color: T.text3, fontWeight: 400 }}> · on/off and cooldowns are not applied</span>
        </span>
        <div className="flex gap-1">
          {rows.length > hits.length && (
            <Btn small onClick={() => setAll(!all)}>
              {all ? 'Matches only' : 'Show all'}
            </Btn>
          )}
          <Btn small onClick={onClose}>
            Close
          </Btn>
        </div>
      </div>
      {note && (
        <span className="text-xs" style={{ color: T.text3, lineHeight: 1.45 }}>
          {note}
        </span>
      )}
      {shown.map((r, i) => (
        <div key={i} className="flex items-start gap-2 text-xs" style={{ lineHeight: 1.45 }}>
          <span className="shrink-0 mt-0.5 rounded-full" style={{ width: 7, height: 7, background: r.why ? T.green : T.border }} />
          <div className="min-w-0 flex flex-col gap-0.5">
            <span style={{ color: r.why ? T.text : T.text3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.text}</span>
            {r.why && <span style={{ color: T.violet, fontFamily: T.mono }}>{r.why}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

export function PlaybooksView() {
  const version = useStore((s) => s.playbooksVersion)
  const focus = useStore((s) => s.playbookFocus)
  const openPlaybook = useStore((s) => s.openPlaybook)
  const pushToast = useStore((s) => s.pushToast)
  const [data, setData] = useState<PlaybooksState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** The editor: which file it was opened from (null = a new one not yet saved), its name and text. */
  const [draft, setDraft] = useState<{ from: string | null; id: string; text: string } | null>(null)
  const [check, setCheck] = useState<PlaybookCheck | null>(null)
  const [test, setTest] = useState<{ rows: PlaybookTestRow[]; note?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await window.api.playbooks.list())
    } catch (err) {
      pushToast('error', `Could not read the playbooks: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [pushToast])

  useEffect(() => {
    void load()
  }, [load, version])

  // loadable ones first, by title; files that could not be read go last
  const list = useMemo(
    () => [...(data?.playbooks ?? [])].sort((a, b) => Number(b.ok) - Number(a.ok) || (a.title ?? a.id).localeCompare(b.title ?? b.id)),
    [data]
  )
  const current = list.find((p) => p.id === selected) ?? null
  const dirty = !!draft && (draft.from === null || draft.from !== draft.id || current?.source !== draft.text)

  const open = useCallback((p: PlaybookInfo) => {
    setSelected(p.id)
    setDraft({ from: p.id, id: p.id, text: p.source })
    setTest(null)
    setConfirmDelete(false)
  }, [])

  // first load, a chip in the chat, or the selected file disappearing: pick what to show
  useEffect(() => {
    if (!data) return
    if (focus) {
      const p = list.find((x) => x.id === focus)
      if (p) open(p)
      openPlaybook(null)
      return
    }
    if (draft?.from === null) return
    if (!selected || !list.some((p) => p.id === selected)) {
      if (list[0]) open(list[0])
      else {
        setSelected(null)
        setDraft(null)
      }
    } else if (draft && !dirty && current && draft.text !== current.source) {
      // changed on disk (another editor, or a toggle) while nothing was edited here: follow it
      setDraft({ from: current.id, id: current.id, text: current.source })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focus])

  // check as you type
  useEffect(() => {
    if (!draft) {
      setCheck(null)
      return
    }
    const id = draft.id
    if (!ID_RE.test(id)) {
      setCheck({ errors: [{ line: 0, message: 'the name must be lowercase letters, digits, - or _' }], warnings: [] })
      return
    }
    const t = setTimeout(() => {
      window.api.playbooks.check(id, draft.text).then(setCheck, () => setCheck(null))
    }, 200)
    return () => clearTimeout(t)
  }, [draft])

  const save = async () => {
    if (!draft || busy) return
    setBusy(true)
    try {
      const r = await window.api.playbooks.save(draft.id, draft.text, draft.from ?? undefined)
      if (!r.ok) {
        setCheck({ errors: r.errors, warnings: check?.warnings ?? [] })
        pushToast('warn', `Not saved: ${r.errors[0] ? issueText(r.errors[0]) : 'the file does not load'}`)
        return
      }
      setSelected(r.id)
      setDraft({ from: r.id, id: r.id, text: draft.text })
      await load()
    } catch (err) {
      pushToast('error', `Could not save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (p: PlaybookInfo, on: boolean) => {
    const r = await window.api.playbooks.toggle(p.id, on)
    if (!r.ok) pushToast('warn', `Could not switch it ${on ? 'on' : 'off'}: ${r.errors[0] ? issueText(r.errors[0]) : ''}`)
    await load()
  }

  const create = (text = NEW_PLAYBOOK, base = 'new-playbook') => {
    setSelected(null)
    setDraft({ from: null, id: freeId(base, list.map((p) => p.id)), text })
    setTest(null)
    setConfirmDelete(false)
  }

  const remove = async () => {
    if (!draft?.from) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await window.api.playbooks.delete(draft.from)
    setConfirmDelete(false)
    setSelected(null)
    setDraft(null)
    await load()
  }

  const runTest = async () => {
    if (!draft) return
    setTesting(true)
    try {
      const r = await window.api.playbooks.test(draft.id, draft.text)
      if (r.errors.length) {
        setCheck({ errors: r.errors, warnings: check?.warnings ?? [] })
        setTest(null)
      } else setTest({ rows: r.rows, note: r.jevNote })
    } finally {
      setTesting(false)
    }
  }

  const on = list.filter((p) => p.ok && p.enabled).length
  const needJev = list.filter((p) => p.ok && p.enabled && p.usesJev).length
  const broken = list.filter((p) => !p.ok).length
  const errors = check?.errors.length ?? 0

  return (
    <Page
      title="Playbooks"
      sub="Situations the assistant recognises in what you say, and how it should handle them. When a playbook's trigger matches, its instruction shapes that reply; the chat shows a chip and the Console says why."
      actions={
        <div className="flex gap-2">
          <Btn icon={FolderOpen} onClick={() => void window.api.playbooks.openFolder()}>
            Open folder
          </Btn>
          <Btn icon={Plus} primary onClick={() => create()}>
            New playbook
          </Btn>
        </div>
      }
    >
      <div className="text-xs" style={{ color: T.text3 }}>
        {list.length - broken} playbook{list.length - broken === 1 ? '' : 's'}, {on} on
        {broken > 0 && <span style={{ color: T.red }}> · {broken} could not be read</span>}
        {data && (
          <span title={data.dir} style={{ fontFamily: T.mono }}>
            {' '}
            · one .md file each in the playbooks folder
          </span>
        )}
      </div>

      {needJev > 0 && data && data.jev !== 'ready' && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2" style={{ background: T.amberTint, color: T.text, lineHeight: 1.5 }}>
          <AlertTriangle size={13} style={{ color: T.amber, flexShrink: 0, marginTop: 2 }} />
          <span>
            {needJev} playbook{needJev === 1 ? ' needs' : 's need'} Jev to fire, and{' '}
            {data.jev === 'off' ? 'asking Jev is switched off (Settings > Tuning > Playbooks).' : 'there is no TypeSafe key yet. Add it in Settings > Providers.'} Until then they never fire; the rest work as normal.
          </span>
        </div>
      )}

      <div className="flex gap-4 items-start">
        <div className="flex flex-col gap-2 shrink-0" style={{ width: 300 }}>
          {list.map((p) => (
            <ListItem key={p.id} p={p} active={draft?.from === p.id} onSelect={() => open(p)} onToggle={(v) => void toggle(p, v)} />
          ))}
          {draft?.from === null && (
            <Card pad={12} active>
              <div className="flex items-center gap-2">
                <Plus size={14} style={{ color: T.cyan }} />
                <span className="text-sm font-medium">New, not saved yet</span>
              </div>
            </Card>
          )}
          {!list.length && draft?.from !== null && (
            <Card>
              <Empty>No playbooks yet. Start one with New playbook.</Empty>
            </Card>
          )}
        </div>

        {draft ? (
          <Card className="flex-1 min-w-0 flex flex-col gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center rounded-lg overflow-hidden" style={{ border: `1px solid ${ID_RE.test(draft.id) ? T.border : T.red}`, background: T.bg }}>
                <input
                  aria-label="File name"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value.trim() })}
                  className="px-2 py-1 text-sm"
                  style={{ background: 'transparent', color: T.text, fontFamily: T.mono, width: 200, border: 'none', outline: 'none' }}
                />
                <span className="pr-2 text-sm" style={{ color: T.text3, fontFamily: T.mono }}>
                  .md
                </span>
              </div>
              <span
                className="text-xs rounded px-1.5 py-0.5"
                style={{ background: errors ? T.redTint : dirty ? alpha(T.amber, 14) : T.greenTint, color: errors ? T.red : dirty ? T.amber : T.green }}
              >
                {errors ? `${errors} problem${errors === 1 ? '' : 's'}` : dirty ? 'unsaved changes' : 'saved'}
              </span>
              <div className="flex-1" />
              <Btn small icon={FlaskConical} onClick={() => void runTest()} disabled={errors > 0 || testing}>
                {testing ? 'Testing…' : 'Test on recent messages'}
              </Btn>
            </div>

            <div className="rounded-lg overflow-hidden" style={{ height: 380, border: `1px solid ${T.border}` }}>
              <Suspense fallback={<div className="h-full" style={{ background: T.bg }} />}>
                <CodeEditor wrap path="playbook.yaml" value={draft.text} onChange={(text) => setDraft((d) => (d ? { ...d, text } : d))} onSave={() => void save()} />
              </Suspense>
            </div>

            <Issues check={check} />
            {test && <TestResults rows={test.rows} note={test.note} onClose={() => setTest(null)} />}

            <div className="text-xs" style={{ color: T.text3, lineHeight: 1.5 }}>
              Ctrl+S saves. A file with problems is not saved, so what is on disk always loads. The format is in _guide.md in the playbooks folder.
            </div>
            <div className="flex items-center gap-1.5">
              {draft.from && (
                <Btn small icon={Copy} onClick={() => create(draft.text, `${draft.id}-copy`)}>
                  Duplicate
                </Btn>
              )}
              {draft.from && (
                <Btn small danger icon={Trash2} onClick={() => void remove()}>
                  {confirmDelete ? 'Click again to delete' : 'Delete'}
                </Btn>
              )}
              <div className="flex-1" />
              <div className="flex gap-1.5 shrink-0">
                {dirty && (
                  <Btn
                    small
                    icon={RotateCcw}
                    onClick={() => {
                      if (draft.from && current) open(current)
                      else if (list[0]) open(list[0])
                      else setDraft(null)
                    }}
                  >
                    {draft.from ? 'Revert' : 'Discard'}
                  </Btn>
                )}
                <Btn small primary icon={Save} onClick={() => void save()} disabled={!dirty || errors > 0 || busy}>
                  {busy ? 'Saving…' : 'Save'}
                </Btn>
              </div>
            </div>
          </Card>
        ) : (
          <Card className="flex-1">
            <Empty>Pick a playbook to see and edit its file.</Empty>
          </Card>
        )}
      </div>
    </Page>
  )
}
