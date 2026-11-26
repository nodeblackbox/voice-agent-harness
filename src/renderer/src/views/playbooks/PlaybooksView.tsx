/**
 * Playbooks (docs/TRIGGERS.md): each one is a Markdown file whose header says when it applies and whose body says
 * what the assistant should do; a runbook adds steps that run in the background. The page is a sidebar of them
 * (search, filters, what is running) and a detail panel with tabs: Setup (a form over the header), Steps (runbooks,
 * with a live flowchart), Check (problems, test on recent messages, review), Activity, and the File itself.
 * Edits stay as drafts per file until saved, and a file with problems is never saved, so what is on disk loads.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, BookOpen, Copy, FileCode, FlaskConical, History, ListChecks, Mic, Plus, RotateCcw, Save, Scale, Settings2, Trash2, Workflow } from 'lucide-react'
import type { PlaybookCheck, PlaybookEvalResult, PlaybookEvalRow, PlaybookInfo, PlaybookLabel, PlaybooksState, PlaybookTestRow, RunbookRun } from '@shared/types'
import { NEW_PLAYBOOK_TEXT, NEW_RUNBOOK_TEXT, field, readPlaybookFile, setPlaybookField } from '@shared/playbookFile'
import { T, alpha } from '../../theme'
import { useStore } from '../../state/store'
import { Btn, Select, Toggle } from '../../components/primitives'
import { ago, freeId, issueText, Issues, ReviewPanel, RunRow, Section, TestResults, withLabel } from './parts'
import { Sidebar } from './Sidebar'
import { FormEditor } from './FormEditor'
import { StepsEditor } from './StepsEditor'

const CodeEditor = lazy(() => import('../claude/CodeEditor'))

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/
/** The key of a new file that has not been saved yet (not a valid file name, so it never clashes). */
const NEW = ':new'

type Tab = 'setup' | 'steps' | 'check' | 'activity' | 'file'
interface Draft {
  /** The file it was opened from; null = a new one. */
  from: string | null
  id: string
  text: string
}

const PRIORITY_OPTIONS = [
  { id: 'low', label: 'Low priority' },
  { id: 'normal', label: 'Normal priority' },
  { id: 'high', label: 'High priority' },
  { id: 'critical', label: 'Critical' }
]

function TabButton({ id, tab, setTab, icon: Icon, children, badge, badgeColor }: { id: Tab; tab: Tab; setTab: (t: Tab) => void; icon: typeof Settings2; children: ReactNode; badge?: number; badgeColor?: string }) {
  const sel = tab === id
  return (
    <button
      type="button"
      role="tab"
      aria-selected={sel}
      onClick={() => setTab(id)}
      className="inline-flex items-center gap-1.5 px-3 text-sm"
      style={{ height: 38, cursor: 'pointer', background: 'none', border: 'none', borderBottom: `2px solid ${sel ? T.cyan : 'transparent'}`, color: sel ? T.text : T.text2, fontWeight: sel ? 600 : 500, marginBottom: -1 }}
    >
      <Icon size={14} style={{ color: sel ? T.cyan : T.text3 }} />
      {children}
      {!!badge && (
        <span className="text-[10.5px] rounded-full px-1.5" style={{ background: alpha(badgeColor ?? T.text3, 16), color: badgeColor ?? T.text2, fontFamily: T.mono, lineHeight: '16px' }}>
          {badge}
        </span>
      )}
    </button>
  )
}

function Welcome({ onNew }: { onNew: (kind: 'playbook' | 'runbook') => void }) {
  const card = (kind: 'playbook' | 'runbook', title: string, text: string, example: string) => (
    <button
      type="button"
      onClick={() => onNew(kind)}
      className="flex flex-col gap-2 rounded-xl p-4 text-left"
      style={{ cursor: 'pointer', background: T.surface, border: `1px solid ${T.border}` }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = kind === 'runbook' ? T.cyanBorder : T.violetBorder)}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = T.border)}
    >
      <span className="inline-flex items-center gap-2 text-sm font-semibold" style={{ color: T.text }}>
        {kind === 'runbook' ? <ListChecks size={16} style={{ color: T.cyan }} /> : <Workflow size={16} style={{ color: T.violet }} />}
        {title}
      </span>
      <span className="text-xs" style={{ color: T.text2, lineHeight: 1.55 }}>
        {text}
      </span>
      <span className="text-[11px] rounded-md px-2 py-1.5" style={{ background: T.bg, color: T.text3, lineHeight: 1.5 }}>
        {example}
      </span>
      <span className="inline-flex items-center gap-1 text-xs font-medium mt-1" style={{ color: kind === 'runbook' ? T.cyan : T.violet }}>
        <Plus size={12} /> New {kind}
      </span>
    </button>
  )
  return (
    <div className="va-scroll flex-1 overflow-y-auto">
      <div className="mx-auto flex flex-col gap-5 px-6 py-10" style={{ maxWidth: 720 }}>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-xl font-semibold" style={{ margin: 0, color: T.text }}>
            Teach the assistant how to handle things
          </h2>
          <p className="text-sm" style={{ margin: 0, color: T.text2, lineHeight: 1.6 }}>
            Each one is a small file with a trigger (what to look out for) and what to do then. They live in the playbooks folder, so you can edit them here, in any editor, or by voice.
          </p>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
          {card('playbook', 'Playbook', 'Shapes the reply when it fires: an instruction the assistant follows for that message.', 'When I say “push the changes”: check what changed and offer a commit message first.')}
          {card('runbook', 'Runbook', 'A job of several steps that runs in the background: think, check, ask you, use a tool, start Claude Code.', 'When a Claude Code session finishes with uncommitted changes: ask whether to push them.')}
        </div>
        <div className="flex items-start gap-2.5 rounded-xl px-4 py-3" style={{ background: T.surface, border: `1px dashed ${T.border}` }}>
          <Mic size={15} style={{ color: T.cyan, flexShrink: 0, marginTop: 2 }} />
          <span className="text-xs" style={{ color: T.text2, lineHeight: 1.6 }}>
            Or just say it: “make a playbook that, when I ask for a summary, keeps it to three bullet points”. The assistant writes the file and you can review it here.
          </span>
        </div>
      </div>
    </div>
  )
}

export function PlaybooksView() {
  const version = useStore((s) => s.playbooksVersion)
  const focus = useStore((s) => s.playbookFocus)
  const openPlaybook = useStore((s) => s.openPlaybook)
  const pushToast = useStore((s) => s.pushToast)
  const runsVersion = useStore((s) => s.runbooksVersion)

  const [data, setData] = useState<PlaybooksState | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  /** Unsaved edits, by file (or NEW). A file with no entry shows what is on disk. */
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [tab, setTab] = useState<Tab>('setup')
  const [check, setCheck] = useState<PlaybookCheck | null>(null)
  const [diagram, setDiagram] = useState<string | null>(null)
  const [test, setTest] = useState<{ rows: PlaybookTestRow[]; note?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [review, setReview] = useState<PlaybookEvalResult | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [runs, setRuns] = useState<RunbookRun[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  // another file or tab starts at its top
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
  }, [selected, tab])

  useEffect(() => {
    let live = true
    // a run moving on pushes an event per step; one read per burst is plenty
    const t = setTimeout(() => {
      window.api.runbooks?.runs().then((r) => live && setRuns(r), () => undefined)
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [runsVersion])
  const cancelRun = (runId: string) => void window.api.runbooks.cancel(runId).then(() => window.api.runbooks.runs().then(setRuns))

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

  const list = useMemo(() => [...(data?.playbooks ?? [])].sort((a, b) => Number(b.ok) - Number(a.ok) || Number(a.kind === 'runbook') - Number(b.kind === 'runbook') || (a.title ?? a.id).localeCompare(b.title ?? b.id)), [data])
  const current = selected && selected !== NEW ? (list.find((p) => p.id === selected) ?? null) : null
  const draft: Draft | null = selected ? (drafts[selected] ?? (current ? { from: current.id, id: current.id, text: current.source } : null)) : null
  const dirty = !!selected && !!drafts[selected]
  const header = draft ? readPlaybookFile(draft.text).header : null
  const kind: 'playbook' | 'runbook' = header ? (header.kind === 'runbook' ? 'runbook' : 'playbook') : (current?.kind ?? 'playbook')
  const errors = check?.errors.length ?? 0
  const warnings = check?.warnings.length ?? 0

  const edit = useCallback(
    (next: Partial<Draft>) => {
      if (!selected || !draft) return
      const d = { ...draft, ...next }
      setDrafts((all) => {
        const copy = { ...all }
        // back to what is on disk: no longer a draft
        if (d.from !== null && current && d.id === current.id && d.text === current.source) delete copy[selected]
        else copy[selected] = d
        return copy
      })
    },
    [selected, draft, current]
  )
  const setText = useCallback((text: string) => edit({ text }), [edit])

  const select = useCallback((id: string | null) => {
    setSelected(id)
    setTest(null)
    setReview(null)
    setConfirmDelete(false)
    setDiagram(null)
  }, [])

  // first load, a chip in the chat, or the selected file disappearing: pick what to show
  useEffect(() => {
    if (!data) return
    if (focus) {
      if (list.some((x) => x.id === focus)) select(focus)
      openPlaybook(null)
      return
    }
    if (selected === NEW) return
    if (!selected || !list.some((p) => p.id === selected)) select(list[0]?.id ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, focus])

  // a playbook has no Steps tab
  useEffect(() => {
    if (tab === 'steps' && kind !== 'runbook') setTab('setup')
  }, [tab, kind])

  // check as you type (also draws a runbook's flowchart)
  const draftId = draft?.id
  const draftText = draft?.text
  useEffect(() => {
    if (draftId === undefined || draftText === undefined) {
      setCheck(null)
      return
    }
    if (!ID_RE.test(draftId)) {
      setCheck({ errors: [{ line: 0, message: 'the file name must be lowercase letters, digits, - or _' }], warnings: [] })
      return
    }
    const t = setTimeout(() => {
      window.api.playbooks.check(draftId, draftText).then(
        (c) => {
          setCheck(c)
          if (c.diagram) setDiagram(c.diagram)
        },
        () => setCheck(null)
      )
    }, 200)
    return () => clearTimeout(t)
  }, [draftId, draftText])

  const save = async () => {
    if (!draft || !selected || busy || !dirty) return
    if (errors) {
      setTab('check')
      pushToast('warn', `Not saved: ${check?.errors[0] ? issueText(check.errors[0]) : 'the file has problems'}`)
      return
    }
    setBusy(true)
    try {
      const r = await window.api.playbooks.save(draft.id, draft.text, draft.from ?? undefined)
      if (!r.ok) {
        setCheck({ errors: r.errors, warnings: check?.warnings ?? [] })
        setTab('check')
        pushToast('warn', `Not saved: ${r.errors[0] ? issueText(r.errors[0]) : 'the file does not load'}`)
        return
      }
      setDrafts((all) => {
        const copy = { ...all }
        delete copy[selected]
        return copy
      })
      setSelected(r.id)
      await load()
    } catch (err) {
      pushToast('error', `Could not save: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const revert = () => {
    if (!selected) return
    setDrafts((all) => {
      const copy = { ...all }
      delete copy[selected]
      return copy
    })
    if (selected === NEW) select(list[0]?.id ?? null)
  }

  const toggle = async (p: PlaybookInfo, on: boolean) => {
    const r = await window.api.playbooks.toggle(p.id, on)
    if (!r.ok) pushToast('warn', `Could not switch it ${on ? 'on' : 'off'}: ${r.errors[0] ? issueText(r.errors[0]) : ''}`)
    await load()
  }

  const create = (text: string, base: string) => {
    setDrafts((all) => ({ ...all, [NEW]: { from: null, id: freeId(base, list.map((p) => p.id)), text } }))
    select(NEW)
    setTab('setup')
  }
  const createKind = (k: 'playbook' | 'runbook') => create(k === 'runbook' ? NEW_RUNBOOK_TEXT : NEW_PLAYBOOK_TEXT, `new-${k}`)

  const remove = async () => {
    if (!draft?.from) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await window.api.playbooks.delete(draft.from)
    const gone = draft.from
    setDrafts((all) => {
      const copy = { ...all }
      delete copy[gone]
      return copy
    })
    select(list.find((p) => p.id !== gone)?.id ?? null)
    await load()
  }
  useEffect(() => {
    if (!confirmDelete) return
    const t = setTimeout(() => setConfirmDelete(false), 4000)
    return () => clearTimeout(t)
  }, [confirmDelete])

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
  const runReview = async () => {
    if (!draft) return
    setReviewing(true)
    try {
      const r = await window.api.playbooks.evaluate(draft.from ?? draft.id, draft.text)
      if (r.errors.length) setCheck({ errors: r.errors, warnings: check?.warnings ?? [] })
      else setReview(r)
    } catch (err) {
      pushToast('error', `Could not review: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setReviewing(false)
    }
  }
  const mark = (row: PlaybookEvalRow, label: PlaybookLabel | null) => {
    if (!draft?.from || !review) return
    void window.api.playbooks.label(draft.from, row.messageId, label)
    const rows = review.rows.map((r) => (r.messageId === row.messageId ? withLabel(r, label) : r))
    const count = (v: PlaybookEvalRow['verdict']) => rows.filter((r) => r.verdict === v).length
    setReview({ ...review, rows, summary: { ...review.summary, agree: count('agree'), misses: count('miss'), falseFires: count('false_fire'), unsure: count('unsure') } })
  }
  const suggest = async () => {
    if (!draft) return
    setSuggesting(true)
    try {
      const r = await window.api.playbooks.suggest(draft.from ?? draft.id, draft.text)
      if (r.ok) {
        setText(r.text)
        setReview(null)
        setTab('setup')
        pushToast('info', 'A tighter trigger is in place. Check it, test it, then Save.')
      } else pushToast('warn', `No suggestion: ${r.errors[0] ? issueText(r.errors[0]) : 'the draft did not load'}`)
    } catch (err) {
      pushToast('error', `Could not draft a suggestion: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSuggesting(false)
    }
  }

  const setHeader = (path: Array<string | number>, value: unknown) => {
    if (!draft) return
    const out = setPlaybookField(draft.text, path, value)
    if (out !== null) setText(out)
  }

  const myRuns = current ? runs.filter((r) => r.runbookId === current.id) : []
  const dirtyIds = Object.keys(drafts).filter((k) => k !== NEW)
  const enabled = header ? field.bool(header.enabled, true) : !!current?.enabled
  const tint = kind === 'runbook' ? T.cyan : T.violet

  return (
    <div className="flex flex-1 min-w-0 min-h-0">
      <Sidebar
        data={data}
        list={list}
        runs={runs}
        selected={selected}
        dirtyIds={dirtyIds}
        newDraft={drafts[NEW] ? (readPlaybookFile(drafts[NEW].text).header?.kind === 'runbook' ? 'runbook' : 'playbook') : null}
        newActive={selected === NEW}
        onSelectNew={() => select(NEW)}
        onSelect={(p) => select(p.id)}
        onToggle={(p, v) => void toggle(p, v)}
        onNew={createKind}
        onCancelRun={cancelRun}
        onOpenRun={(id) => {
          select(id)
          setTab('activity')
        }}
      />

      {!draft ? (
        data ? (
          <Welcome onNew={createKind} />
        ) : (
          <div className="flex-1" />
        )
      ) : (
        <section className="flex-1 flex flex-col min-w-0 min-h-0" aria-label="Playbook">
          <header className="flex flex-col gap-2 px-6 pt-4" style={{ borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            <div className="flex items-start gap-3">
              <span className="rounded-xl inline-flex items-center justify-center shrink-0 mt-0.5" style={{ width: 38, height: 38, background: alpha(tint, 14), border: `1px solid ${alpha(tint, 35)}` }}>
                {kind === 'runbook' ? <ListChecks size={18} style={{ color: tint }} /> : <Workflow size={18} style={{ color: tint }} />}
              </span>
              <div className="flex flex-col min-w-0 flex-1">
                <input
                  aria-label="Title"
                  value={header ? field.str(header.title) : (current?.title ?? draft.id)}
                  disabled={!header}
                  onChange={(e) => setHeader(['title'], e.target.value)}
                  placeholder="Give it a name"
                  className="text-lg font-semibold bg-transparent w-full"
                  style={{ border: 'none', outline: 'none', color: T.text, padding: 0 }}
                />
                <input
                  aria-label="Goal"
                  value={header ? field.str(header.goal) : ''}
                  disabled={!header}
                  onChange={(e) => setHeader(['goal'], e.target.value)}
                  placeholder="What it is for, in one sentence"
                  title={header ? field.str(header.goal) : undefined}
                  className="text-sm bg-transparent w-full"
                  style={{ border: 'none', outline: 'none', color: T.text2, padding: 0 }}
                />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {header && (
                  <label className="inline-flex items-center gap-2 text-xs" style={{ color: enabled ? T.green : T.text3 }} title="Switch it on or off. Saved with the rest of your changes.">
                    <Toggle on={enabled} onChange={(v) => setHeader(['enabled'], v)} />
                    {enabled ? 'On' : 'Off'}
                  </label>
                )}
                {header && <Select value={field.str(header.priority, 'normal')} onChange={(v) => setHeader(['priority'], v === 'normal' ? undefined : v)} options={PRIORITY_OPTIONS} width={150} />}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap text-xs" style={{ paddingLeft: 50 }}>
              <div className="flex items-center rounded-md overflow-hidden" style={{ border: `1px solid ${ID_RE.test(draft.id) ? T.border : T.red}`, background: T.bg }} title="The file name in the playbooks folder">
                <input
                  aria-label="File name"
                  value={draft.id}
                  onChange={(e) => edit({ id: e.target.value.trim() })}
                  className="pl-2 py-0.5 text-xs"
                  style={{ background: 'transparent', color: T.text2, fontFamily: T.mono, width: Math.max(80, draft.id.length * 7 + 12), border: 'none', outline: 'none' }}
                />
                <span className="pr-2 text-xs" style={{ color: T.text3, fontFamily: T.mono }}>
                  .md
                </span>
              </div>
              <span className="rounded px-1.5 py-0.5" style={{ background: errors ? T.redTint : dirty ? alpha(T.amber, 14) : T.greenTint, color: errors ? T.red : dirty ? T.amber : T.green }}>
                {errors ? `${errors} problem${errors === 1 ? '' : 's'}` : dirty ? (draft.from ? 'unsaved changes' : 'not saved yet') : 'saved'}
              </span>
              {current && (
                <span style={{ color: T.text3 }}>
                  {current.firedCount ? `fired ${current.firedCount}× this run, last ${ago(current.lastFiredAt)}` : 'not fired this run'}
                </span>
              )}
              {kind === 'runbook' && myRuns.some((r) => r.status === 'running' || r.status === 'waiting') && (
                <span className="inline-flex items-center gap-1" style={{ color: T.cyan }}>
                  <span className="rounded-full va-pulse" style={{ width: 6, height: 6, background: T.cyan }} /> running now
                </span>
              )}
              <div className="flex-1" />
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
            </div>

            <div className="flex items-end gap-1 mt-1" role="tablist" aria-label="Sections" style={{ paddingLeft: 38 }}>
              <TabButton id="setup" tab={tab} setTab={setTab} icon={Settings2}>
                Setup
              </TabButton>
              {kind === 'runbook' && (
                <TabButton id="steps" tab={tab} setTab={setTab} icon={ListChecks} badge={Array.isArray(header?.steps) ? (header.steps as unknown[]).length : current?.stepCount}>
                  Steps
                </TabButton>
              )}
              <TabButton id="check" tab={tab} setTab={setTab} icon={FlaskConical} badge={errors || warnings} badgeColor={errors ? T.red : T.amber}>
                Check
              </TabButton>
              <TabButton id="activity" tab={tab} setTab={setTab} icon={History} badge={kind === 'runbook' ? myRuns.length : current?.firedCount}>
                Activity
              </TabButton>
              <TabButton id="file" tab={tab} setTab={setTab} icon={FileCode}>
                File
              </TabButton>
            </div>
          </header>

          <div ref={scroller} className="va-scroll flex-1 overflow-y-auto min-h-0">
            <div className="flex flex-col gap-4 px-6 py-5" style={{ maxWidth: tab === 'steps' ? 1280 : tab === 'file' ? undefined : 880 }}>
              {current && !current.ok && !dirty && (
                <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2" style={{ background: T.redTint, color: T.text, lineHeight: 1.5 }}>
                  <AlertTriangle size={13} style={{ color: T.red, flexShrink: 0, marginTop: 2 }} />
                  <span>This file can't be loaded, so it never fires. {current.errors[0] ? issueText(current.errors[0]) : ''}</span>
                </div>
              )}

              {tab === 'setup' && <FormEditor text={draft.text} kind={kind} onChange={setText} onShowFile={() => setTab('file')} />}

              {tab === 'steps' && <StepsEditor text={draft.text} onChange={setText} diagram={diagram} stale={errors > 0} onShowFile={() => setTab('file')} />}

              {tab === 'check' && (
                <>
                  <Section title="Problems" hint="Checked as you type, with the same rules the app loads files with.">
                    <Issues check={check} />
                  </Section>
                  <Section
                    title="Test on recent messages"
                    hint="Replays your last messages through this version of the trigger, so you see what would have set it off before you save."
                    right={
                      <Btn small primary icon={FlaskConical} onClick={() => void runTest()} disabled={errors > 0 || testing}>
                        {testing ? 'Testing…' : 'Run test'}
                      </Btn>
                    }
                  >
                    {test ? <TestResults rows={test.rows} note={test.note} onClose={() => setTest(null)} /> : null}
                  </Section>
                  <Section
                    title="Review"
                    hint="A judge (Jev, or the model) says whether it should have fired on each message, so you see misses and false alarms. Mark the ones it got wrong; your marks count over the judge."
                    right={
                      <Btn small icon={Scale} onClick={() => void runReview()} disabled={errors > 0 || reviewing}>
                        {reviewing ? 'Reviewing…' : 'Review'}
                      </Btn>
                    }
                  >
                    {review ? <ReviewPanel result={review} canMark={!!draft.from} onMark={mark} onSuggest={() => void suggest()} suggesting={suggesting} onClose={() => setReview(null)} /> : null}
                  </Section>
                </>
              )}

              {tab === 'activity' && (
                <>
                  <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
                    {[
                      { label: 'Fired this run', value: String(current?.firedCount ?? 0) },
                      { label: 'Last fired', value: current?.lastFiredAt ? ago(current.lastFiredAt) : 'not yet' },
                      ...(kind === 'runbook'
                        ? [
                            { label: 'Runs', value: String(myRuns.length) },
                            { label: 'Finished well', value: myRuns.length ? `${myRuns.filter((r) => r.status === 'done').length} of ${myRuns.length}` : '–' }
                          ]
                        : [])
                    ].map((s) => (
                      <div key={s.label} className="rounded-xl px-4 py-3 flex flex-col gap-0.5" style={{ background: T.surface, border: `1px solid ${T.border}` }}>
                        <span className="text-[11px]" style={{ color: T.text3 }}>
                          {s.label}
                        </span>
                        <span className="text-lg font-semibold" style={{ color: T.text }}>
                          {s.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  {kind === 'runbook' ? (
                    <Section title="Recent runs" hint="Newest first. Steps shows what each step did and how long it took.">
                      {myRuns.length ? (
                        <div className="flex flex-col gap-1.5">
                          {myRuns.slice(0, 20).map((r) => (
                            <RunRow key={r.runId} run={r} onCancel={() => cancelRun(r.runId)} />
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs" style={{ color: T.text3 }}>
                          It has not run yet. Once its trigger matches, each run shows up here.
                        </span>
                      )}
                    </Section>
                  ) : (
                    <Section title="Where to see it fire" hint="Each time a playbook fires, the reply in the chat carries a chip with its name, and the Console says which part of the trigger matched.">
                      <span className="text-xs" style={{ color: T.text3 }}>
                        Counts start again when the app restarts. To see what it would catch, use Check › Test on recent messages.
                      </span>
                    </Section>
                  )}
                </>
              )}

              {tab === 'file' && (
                <>
                  <div className="rounded-xl overflow-hidden" style={{ height: 'calc(100vh - 290px)', minHeight: 360, border: `1px solid ${T.border}` }}>
                    <Suspense fallback={<div className="h-full" style={{ background: T.bg }} />}>
                      <CodeEditor wrap path="playbook.yaml" value={draft.text} onChange={setText} onSave={() => void save()} />
                    </Suspense>
                  </div>
                  <Issues check={check} compact />
                  <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: T.text3 }}>
                    <BookOpen size={12} /> The whole format is in _guide.md in the playbooks folder. The form and this file are the same thing: edit either.
                  </span>
                </>
              )}
            </div>
          </div>

          {dirty && (
            <div className="flex items-center gap-3 px-6 va-fade" style={{ height: 52, flexShrink: 0, borderTop: `1px solid ${T.border}`, background: T.surface }}>
              <span className="rounded-full" style={{ width: 7, height: 7, background: errors ? T.red : T.amber }} />
              <span className="text-sm" style={{ color: T.text }}>
                {draft.from ? 'Unsaved changes' : 'New, not saved yet'}
              </span>
              {errors > 0 && (
                <button type="button" onClick={() => setTab('check')} className="text-xs" style={{ color: T.red, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
                  {errors} problem{errors === 1 ? '' : 's'} to fix first
                </button>
              )}
              <div className="flex-1" />
              <span className="text-[11px]" style={{ color: T.text3 }}>
                Ctrl+S
              </span>
              <Btn small icon={RotateCcw} onClick={revert}>
                {draft.from ? 'Revert' : 'Discard'}
              </Btn>
              <Btn small primary icon={Save} onClick={() => void save()} disabled={errors > 0 || busy}>
                {busy ? 'Saving…' : 'Save'}
              </Btn>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
