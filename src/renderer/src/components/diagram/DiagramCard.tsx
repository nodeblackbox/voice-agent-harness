/**
 * A diagram in the chat. Three views of the same thing: the picture, its Mermaid code (editable, saved as
 * a new version), and what changed since the version before (red and green). Every version is kept and can
 * be stepped through or brought back.
 */
import { Suspense, lazy, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, Copy, Download, Expand, GitCompareArrows, History, Pencil, RotateCcw, Save, Workflow, X, type LucideIcon } from 'lucide-react'
import { diagramKind, diffLabel, latest, type DiagramCheck, type DiagramDoc } from '@shared/diagram'
import { T, TERM, alpha } from '../../theme'
import { useStore } from '../../state/store'
import { useDiagrams } from '../../state/diagrams'
import { checkDiagram, renderDiagram } from '../../lib/mermaid'
import { DiagramSurface } from './DiagramSurface'
import { DiffView } from './DiffView'

const CodeEditor = lazy(() => import('../../views/claude/CodeEditor'))

type Tab = 'diagram' | 'code' | 'changes'

const SAVE_KEY = /mac/i.test(navigator.platform) ? '⌘S' : 'Ctrl+S'

function IconBtn({ icon: Icon, label, onClick, active, color }: { icon: LucideIcon; label: string; onClick: () => void; active?: boolean; color?: string }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="inline-flex items-center justify-center rounded-md" style={{ width: 28, height: 28, background: active ? T.raised : 'transparent', border: 'none', color: color ?? T.text3, cursor: 'pointer', flexShrink: 0 }}>
      <Icon size={14} />
    </button>
  )
}

function Tabs({ tab, setTab, changes }: { tab: Tab; setTab: (t: Tab) => void; changes: string }) {
  const item = (id: Tab, label: string, Icon: LucideIcon, extra?: ReactNode) => (
    <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs" style={{ height: 26, background: tab === id ? T.surface : 'transparent', color: tab === id ? T.text : T.text2, border: 'none', cursor: 'pointer', boxShadow: tab === id ? `0 1px 2px ${T.shadow}` : undefined, fontWeight: tab === id ? 600 : 400 }}>
      <Icon size={12} />
      {label}
      {extra}
    </button>
  )
  return (
    <div role="tablist" className="inline-flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: T.raised, flexShrink: 0 }}>
      {item('diagram', 'Diagram', Workflow)}
      {item('code', 'Code', Pencil)}
      {item('changes', 'Changes', GitCompareArrows, changes ? <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text3 }}>{changes}</span> : null)}
    </div>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="va-fade self-stretch flex flex-col overflow-hidden" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 14 }}>
      {children}
    </div>
  )
}

async function downloadSvg(title: string, code: string): Promise<boolean> {
  const r = await renderDiagram(code)
  if (!r.ok) return false
  const url = URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'diagram'}.svg`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
  return true
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  return [
    copied,
    (text) => {
      void navigator.clipboard.writeText(text).catch(() => {})
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  ]
}

/** The picture, full window: scroll to zoom, drag to move, Esc to close. */
export function DiagramOverlay({ title, code, onClose }: { title: string; code: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  // on the page itself, not inside the card: the card clips and animates its children
  return createPortal(
    <div role="dialog" aria-label={title} className="va-fade fixed inset-0 flex flex-col" style={{ zIndex: 60, background: T.bg }}>
      <div className="flex items-center gap-3 px-5" style={{ height: 48, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <Workflow size={15} style={{ color: T.cyan }} />
        <span className="text-sm truncate" style={{ color: T.text, fontWeight: 600 }}>{title}</span>
        <span className="text-xs" style={{ color: T.text3 }}>Scroll to zoom · drag to move · double-click to fit</span>
        <span className="flex-1" />
        <IconBtn icon={X} label="Close (Esc)" onClick={onClose} color={T.text2} />
      </div>
      <div className="flex-1 min-h-0">
        <DiagramSurface code={code} mode="panzoom" />
      </div>
    </div>,
    document.body
  )
}

export function DiagramCard({ id, version }: { id: string; version?: number }) {
  const doc = useDiagrams((s) => s.docs[id])
  const ensure = useDiagrams((s) => s.ensure)
  useEffect(() => ensure(id), [ensure, id])
  if (doc === undefined) return <Shell><div className="px-4 py-6 text-xs va-pulse" style={{ color: T.text3 }}>Loading the diagram…</div></Shell>
  if (doc === null) return <Shell><div className="px-4 py-4 text-xs" style={{ color: T.text3 }}>This diagram is no longer in the library.</div></Shell>
  return <Card doc={doc} version={version} />
}

function Card({ doc, version }: { doc: DiagramDoc; version?: number }) {
  const pushToast = useStore((s) => s.pushToast)
  const draft = useDiagrams((s) => s.drafts[doc.id])
  const setDraft = useDiagrams((s) => s.setDraft)
  const apply = useDiagrams((s) => s.apply)
  const newest = latest(doc)
  /** The version on show: the one this chat step produced, until the owner steps or saves. */
  const [n, setN] = useState(version ?? newest.n)
  // a card that is not tied to a step in the chat follows the newest version
  useEffect(() => {
    if (version === undefined) setN(newest.n)
  }, [version, newest.n])
  const index = Math.max(0, doc.versions.findIndex((v) => v.n === n))
  const v = doc.versions[index] ?? newest
  const prev = index > 0 ? doc.versions[index - 1] : undefined
  const isLatest = v.n === newest.n
  const dirty = isLatest && draft !== undefined && draft !== v.code
  const shown = dirty ? draft : v.code
  const [tab, setTab] = useState<Tab>(dirty ? 'code' : 'diagram')
  const [big, setBig] = useState(false)
  const [saving, setSaving] = useState(false)
  const [check, setCheck] = useState<DiagramCheck | null>(null)
  const [copied, copy] = useCopied()

  // the parser runs a moment after typing stops, so Save knows whether the code compiles
  useEffect(() => {
    if (!dirty) return setCheck(null)
    let live = true
    setCheck(null)
    const t = setTimeout(() => void checkDiagram(draft).then((r) => live && setCheck(r)), 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [dirty, draft])

  const changes = useMemo(() => (dirty ? diffLabel(v.code, draft) : prev ? diffLabel(prev.code, v.code) : ''), [dirty, draft, v.code, prev])
  const broken = dirty && check?.ok === false

  const commit = async (code: string, note?: string): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.api.diagrams.save(doc.id, { code, note })
      if (!next) return pushToast('error', 'This diagram is no longer in the library.')
      apply(next.id, next)
      setDraft(doc.id, null)
      setN(latest(next).n)
    } catch (e) {
      pushToast('error', `Could not save the diagram: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }
  const save = (): void => {
    if (!dirty || saving) return
    if (broken) return pushToast('error', 'Not saved: the code has an error. Fix it (see under the editor) or Revert.')
    void commit(draft)
  }
  const restore = (): void => {
    void commit(v.code, `Brought back version ${v.n}`)
  }
  const onChange = (text: string): void => setDraft(doc.id, text === v.code ? null : text)

  const who = v.by === 'user' ? 'edited by you' : v.n === 1 ? 'drawn by the agent' : 'changed by the agent'

  return (
    <Shell>
      <div className="flex items-center gap-2 pl-3.5 pr-2" style={{ minHeight: 44, borderBottom: `1px solid ${T.border}` }}>
        <Workflow size={14} style={{ color: T.cyan, flexShrink: 0 }} />
        <div className="min-w-0 flex-1 flex items-baseline gap-2">
          <span className="text-sm truncate" style={{ color: T.text, fontWeight: 600 }} title={doc.title}>{doc.title}</span>
          {!dirty && <span className="text-xs shrink-0" style={{ color: T.text3 }}>{diagramKind(v.code)}</span>}
          {dirty && <span className="text-xs shrink-0 inline-flex items-center gap-1" style={{ color: T.amber }}><span style={{ width: 6, height: 6, borderRadius: 6, background: T.amber }} />unsaved</span>}
        </div>
        {doc.versions.length > 1 && (
          <div className="inline-flex items-center shrink-0" title={`Version ${v.n}, ${who}${v.note ? `: ${v.note}` : ''}`}>
            <button aria-label="Earlier version" disabled={index === 0} onClick={() => setN(doc.versions[index - 1]!.n)} style={{ background: 'none', border: 'none', padding: 2, color: index === 0 ? T.border : T.text2, cursor: index === 0 ? 'default' : 'pointer', display: 'inline-flex' }}><ChevronLeft size={14} /></button>
            <span className="text-xs" style={{ color: isLatest ? T.text2 : T.amber, fontFamily: T.mono }}>v{v.n} of {newest.n}</span>
            <button aria-label="Later version" disabled={isLatest} onClick={() => setN(doc.versions[index + 1]!.n)} style={{ background: 'none', border: 'none', padding: 2, color: isLatest ? T.border : T.text2, cursor: isLatest ? 'default' : 'pointer', display: 'inline-flex' }}><ChevronRight size={14} /></button>
          </div>
        )}
        <Tabs tab={tab} setTab={setTab} changes={changes} />
        <IconBtn icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy the Mermaid code'} onClick={() => copy(shown)} color={copied ? T.green : undefined} />
        <IconBtn icon={Download} label="Download as SVG" onClick={() => void downloadSvg(doc.title, shown).then((ok) => !ok && pushToast('error', 'Nothing to download: the code has an error.'))} />
        <IconBtn icon={Expand} label="Open full window" onClick={() => setBig(true)} />
      </div>

      {!isLatest && (
        <div className="flex items-center gap-2 px-3.5 py-1.5 text-xs" style={{ background: T.amberTint, color: T.text2, borderBottom: `1px solid ${T.border}` }}>
          <History size={12} style={{ color: T.amber }} />
          <span className="flex-1">An earlier version ({who}). The newest is v{newest.n}.</span>
          <button onClick={() => setN(newest.n)} className="underline" style={{ background: 'none', border: 'none', color: T.text2, cursor: 'pointer', padding: 0 }}>Go to newest</button>
          <button onClick={restore} disabled={saving} className="underline" style={{ background: 'none', border: 'none', color: T.amber, cursor: 'pointer', padding: 0 }}>Bring this one back</button>
        </div>
      )}

      {tab === 'diagram' && <DiagramSurface code={shown} />}

      {tab === 'code' && (
        <>
          <div style={{ height: 300, background: TERM.bg }}>
            <Suspense fallback={<div className="p-4 text-xs" style={{ color: TERM.dim }}>Loading the editor…</div>}>
              <CodeEditor path="diagram.mmd" value={shown} readOnly={!isLatest} onChange={onChange} onSave={save} />
            </Suspense>
          </div>
          <div className="flex items-center gap-2 px-3.5" style={{ minHeight: 40, borderTop: `1px solid ${TERM.border}`, background: TERM.chrome }}>
            <span className="text-xs min-w-0 flex-1 truncate" style={{ fontFamily: T.mono, fontSize: 11, color: broken ? TERM.err : dirty ? (check?.ok ? alpha(T.green, 85) : TERM.dim) : TERM.dim }} title={broken && check && !check.ok ? check.error : undefined}>
              {!isLatest
                ? 'Read-only: this is an earlier version'
                : broken && check && !check.ok
                  ? check.error.split('\n').filter(Boolean).slice(0, 2).join(' · ')
                  : dirty
                    ? check?.ok
                      ? `Compiles · ${SAVE_KEY} saves it as version ${newest.n + 1}`
                      : 'Checking…'
                    : `Edit the code; ${SAVE_KEY} saves a new version`}
            </span>
            {dirty && (
              <button onClick={() => setDraft(doc.id, null)} className="inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs" style={{ height: 26, background: 'transparent', border: `1px solid ${TERM.gutter}`, color: TERM.text, cursor: 'pointer' }}>
                <RotateCcw size={12} /> Revert
              </button>
            )}
            {isLatest && (
              <button onClick={save} disabled={!dirty || saving || broken} className="inline-flex items-center gap-1.5 rounded-md px-2.5 text-xs" style={{ height: 26, background: dirty && !broken ? T.cyan : 'transparent', border: `1px solid ${dirty && !broken ? T.cyan : TERM.gutter}`, color: dirty && !broken ? '#06222e' : TERM.dim, cursor: dirty && !broken ? 'pointer' : 'default', fontWeight: 600 }}>
                <Save size={12} /> {saving ? 'Saving…' : `Save · ${SAVE_KEY}`}
              </button>
            )}
          </div>
        </>
      )}

      {tab === 'changes' &&
        (dirty ? (
          <>
            <Caption>Your unsaved changes to version {v.n}</Caption>
            <DiffView before={v.code} after={draft} />
          </>
        ) : prev ? (
          <>
            <Caption>
              Version {prev.n} → {v.n}, {who}
              {v.note ? <span style={{ color: TERM.text }}> · {v.note}</span> : null}
            </Caption>
            <DiffView before={prev.code} after={v.code} />
          </>
        ) : (
          <div className="px-4 py-5 text-xs" style={{ color: T.text3, lineHeight: 1.6 }}>
            This is the first version, so there is nothing to compare yet. Ask for a change, or edit the code, and what changed shows here in red and green.
          </div>
        ))}

      {big && <DiagramOverlay title={doc.title} code={shown} onClose={() => setBig(false)} />}
    </Shell>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-2 text-xs" style={{ background: TERM.chrome, color: TERM.dim, borderBottom: `1px solid ${TERM.border}`, fontFamily: T.mono, fontSize: 11 }}>
      {children}
    </div>
  )
}

/**
 * A Mermaid block someone wrote straight into text (a reply, a Markdown file): drawn in place, with its
 * code one click away. "Keep" turns it into a diagram of its own that can be edited and versioned.
 */
export function InlineDiagram({ code, keep = false }: { code: string; keep?: boolean }) {
  const [tab, setTab] = useState<'diagram' | 'code'>('diagram')
  const [big, setBig] = useState(false)
  const [kept, setKept] = useState<string | null>(null)
  const [copied, copy] = useCopied()
  const apply = useDiagrams((s) => s.apply)
  if (kept) return <DiagramCard id={kept} />
  const canKeep = keep && typeof window.api.diagrams?.create === 'function'
  const doKeep = async (): Promise<void> => {
    const doc = await window.api.diagrams.create({ title: `${diagramKind(code)} from the chat`, code })
    apply(doc.id, doc)
    setKept(doc.id)
  }
  return (
    <Shell>
      <div className="flex items-center gap-2 pl-3.5 pr-2" style={{ minHeight: 40, borderBottom: `1px solid ${T.border}` }}>
        <Workflow size={14} style={{ color: T.cyan }} />
        <span className="text-xs flex-1" style={{ color: T.text2 }}>{diagramKind(code)}</span>
        {canKeep && (
          <button onClick={() => void doKeep()} className="inline-flex items-center gap-1.5 rounded-md px-2 text-xs" style={{ height: 26, background: 'transparent', border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer' }} title="Keep this as a diagram you can edit, with a history of versions">
            <Pencil size={11} /> Edit
          </button>
        )}
        <div className="inline-flex items-center gap-0.5 rounded-lg p-0.5" style={{ background: T.raised }}>
          {(['diagram', 'code'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className="rounded-md px-2.5 text-xs" style={{ height: 24, background: tab === t ? T.surface : 'transparent', color: tab === t ? T.text : T.text2, border: 'none', cursor: 'pointer' }}>
              {t === 'diagram' ? 'Diagram' : 'Code'}
            </button>
          ))}
        </div>
        <IconBtn icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy the Mermaid code'} onClick={() => copy(code)} color={copied ? T.green : undefined} />
        <IconBtn icon={Expand} label="Open full window" onClick={() => setBig(true)} />
      </div>
      {tab === 'diagram' ? (
        <DiagramSurface code={code} />
      ) : (
        <pre className="va-scroll" style={{ margin: 0, padding: '12px 16px', background: TERM.bg, color: TERM.text, fontFamily: T.mono, fontSize: 12, lineHeight: 1.65, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre' }}>{code}</pre>
      )}
      {big && <DiagramOverlay title={diagramKind(code)} code={code} onClose={() => setBig(false)} />}
    </Shell>
  )
}
