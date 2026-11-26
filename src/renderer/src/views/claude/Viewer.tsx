/**
 * The selected file: an editor for text and code (edit, Ctrl+S or Save), a rendered view for Markdown,
 * players for media. Unsaved edits survive switching files; a save never overwrites a change made on disk
 * meanwhile without asking.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Code, Eye, FolderSearch, Globe, Pencil, RotateCcw, Save, TriangleAlert } from 'lucide-react'
import type { CcFileContent } from '@shared/claude'
import { T, TERM, alpha } from '../../theme'
import { useStore } from '../../state/store'
import { draftKey, useDrafts } from '../../state/drafts'
import { Btn } from '../../components/primitives'
import { Markdown } from './Markdown'
import { ext, fmtBytes, isHtml, isMedia, isPdf } from './feed'
import { MediaView } from './Media'
import { useFileMenu } from './FileMenu'
import { languageLabel } from './languages'
import type { EditorStatus } from './CodeEditor'

const CodeEditor = lazy(() => import('./CodeEditor'))

const SAVE_KEY = /mac/i.test(navigator.platform) ? '⌘S' : 'Ctrl+S'
const unix = (s: string): string => s.replace(/\r\n?/g, '\n')

export function Viewer({ id, rel, mtime, size, onPreview, onSaved }: { id: string; rel: string; mtime: number; size: number; onPreview: (rel: string) => void; onSaved: () => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const key = draftKey(id, rel)
  const draft = useDrafts((s) => s.drafts[key])
  const putDraft = useDrafts((s) => s.put)
  const dropDraft = useDrafts((s) => s.drop)
  const [content, setContent] = useState<CcFileContent | { error: string } | null>(null)
  const [editingMd, setEditingMd] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [status, setStatus] = useState<EditorStatus | null>(null)
  const media = isMedia(rel) || isPdf(rel)
  const md = ext(rel) === 'md'

  const load = useCallback(async () => {
    const c = await window.api.claude.read(id, rel)
    setContent(c)
    return c
  }, [id, rel])
  useEffect(() => {
    let live = true
    setContent(null)
    setStatus(null)
    if (media) return
    void window.api.claude.read(id, rel).then((c) => { if (live) setContent(c) })
    return () => { live = false }
  }, [id, rel, mtime, media])
  // a Markdown file with unsaved edits opens in the editor, where the edits are
  useEffect(() => setEditingMd(!!useDrafts.getState().drafts[draftKey(id, rel)]), [id, rel])

  const text = content && 'kind' in content && content.kind === 'text' ? content : null
  const base = useMemo(() => (text ? unix(text.text) : ''), [text])
  const crlf = !!text && text.text.includes('\r\n')
  // the app behind this window may predate saving (it was started before the editor existed)
  const canWrite = typeof window.api.claude?.write === 'function'
  const editable = !!text && !text.truncated && canWrite
  const dirty = !!draft && !!text && draft.text !== base
  // the file was written on disk (by Claude, or another program) after these edits began
  const stale = dirty && Math.abs(draft.baseMtime - (text.mtime ?? draft.baseMtime)) > 1
  const shown = dirty ? draft.text : base

  const onChange = (t: string): void => {
    if (!text) return
    if (t === base) dropDraft(key)
    else putDraft(key, { text: t, baseMtime: draft?.baseMtime ?? text.mtime })
  }
  const save = async (force = false): Promise<void> => {
    if (!text || !dirty || saving) return
    setSaving(true)
    const out = crlf ? draft.text.replace(/\n/g, '\r\n') : draft.text
    const r = await window.api.claude.write(id, rel, out, force ? undefined : draft.baseMtime)
    setSaving(false)
    if (r.ok) {
      setContent({ kind: 'text', text: out, size: r.size, truncated: false, mtime: r.mtime })
      dropDraft(key)
      setSavedAt(Date.now())
      onSaved()
    } else if (r.conflict) {
      await load() // brings in the newer version, which raises the choice below
      pushToast('error', 'Not saved: this file changed on disk while you were editing. Choose which version to keep.')
    } else pushToast('error', r.error)
  }
  const revert = (): void => dropDraft(key)

  // Ctrl+S anywhere in the viewer, not only with the cursor in the editor
  useEffect(() => {
    if (!dirty) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (!savedAt) return
    const t = setTimeout(() => setSavedAt(0), 2200)
    return () => clearTimeout(t)
  }, [savedAt])

  const open = async (how: 'default' | 'reveal' | 'code') => {
    const r = await window.api.claude.open(id, rel, how)
    if (!r.ok) pushToast('error', r.error)
  }
  const menu = useFileMenu()
  const rendered = md && !editingMd
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: `1px solid ${T.border}` }}>
        <span className="text-xs truncate flex-1 inline-flex items-center gap-2" style={{ fontFamily: T.mono, color: T.text2 }} onContextMenu={(e) => menu(e, rel)} title="Right-click to copy the path">
          {dirty && <span aria-label="Unsaved changes" title="Unsaved changes" style={{ width: 7, height: 7, borderRadius: 7, background: T.amber, flexShrink: 0 }} />}
          <span className="truncate">
            {rel.split('/').map((p, i, a) => (
              <span key={i}>
                {i > 0 && <span style={{ color: T.text3 }}> / </span>}
                <span style={{ color: i === a.length - 1 ? T.text : T.text2 }}>{p}</span>
              </span>
            ))}
          </span>
        </span>
        {savedAt > 0 && !dirty && (
          <span className="va-fade text-xs inline-flex items-center gap-1" style={{ color: T.green }}><Check size={12} /> Saved</span>
        )}
        {text && !dirty && savedAt === 0 && <span className="text-xs" style={{ color: T.text3 }}>{fmtBytes(text.size)}</span>}
        {media && <span className="text-xs" style={{ color: T.text3 }}>{fmtBytes(size)}</span>}
        {dirty && <Btn small icon={RotateCcw} onClick={revert}>Revert</Btn>}
        {editable && (
          <span title={dirty ? `Save (${SAVE_KEY})` : 'No changes to save'}>
            <Btn small primary={dirty} icon={Save} disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : `Save · ${SAVE_KEY}`}</Btn>
          </span>
        )}
        {md && text && <Btn small icon={rendered ? Pencil : Eye} onClick={() => setEditingMd(!editingMd)}>{rendered ? 'Edit' : 'Rendered'}</Btn>}
        {isHtml(rel) && <Btn small icon={Eye} onClick={() => onPreview(rel)}>Preview</Btn>}
        <Btn small icon={Globe} onClick={() => void open('default')}>Open</Btn>
        <Btn small icon={Code} onClick={() => void open('code')}>VS Code</Btn>
        <Btn small icon={FolderSearch} onClick={() => void open('reveal')}>Show</Btn>
      </div>

      {stale && (
        <div className="va-fade flex items-center gap-3 px-4 py-2 text-xs" style={{ background: T.amberTint, borderBottom: `1px solid ${T.amber}`, color: T.text }}>
          <TriangleAlert size={14} style={{ color: T.amber, flexShrink: 0 }} />
          <span className="flex-1" style={{ lineHeight: 1.5 }}>This file was changed on disk while you were editing it (Claude or another program saved it). Your edits are still here, unsaved.</span>
          <Btn small onClick={revert}>Load the new version</Btn>
          <Btn small danger onClick={() => void save(true)}>Save mine over it</Btn>
        </div>
      )}

      {media ? (
        <div className="flex-1 min-h-0 flex flex-col p-4">
          <MediaView id={id} rel={rel} mtime={mtime} size={size} />
        </div>
      ) : !content ? (
        <div className="flex-1 p-4 text-xs" style={{ color: T.text3 }}>Loading…</div>
      ) : 'error' in content ? (
        <div className="flex-1 p-4 text-xs" style={{ color: T.red }}>{content.error}</div>
      ) : content.kind === 'binary' ? (
        <div className="flex-1 p-4 text-sm" style={{ color: T.text3 }}>Binary file ({fmtBytes(content.size)}). Use Open to view it.</div>
      ) : rendered ? (
        <div className="va-scroll flex-1 overflow-auto p-4">
          <div style={{ maxWidth: 760 }}><Markdown text={shown} /></div>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-0" style={{ background: TERM.bg }}>
            <Suspense fallback={<div className="p-4 text-xs" style={{ color: TERM.dim }}>Loading the editor…</div>}>
              <CodeEditor path={rel} value={shown} readOnly={!editable} onChange={onChange} onSave={() => void save()} onStatus={setStatus} />
            </Suspense>
          </div>
          <div className="flex items-center gap-3 px-4 text-xs" style={{ height: 26, flexShrink: 0, borderTop: `1px solid ${TERM.border}`, background: TERM.chrome, color: TERM.dim, fontFamily: T.mono, fontSize: 11 }}>
            {status && <span>Ln {status.line}, Col {status.col}{status.selected ? ` (${status.selected} selected)` : ''}</span>}
            {status && <span>{status.lines} lines</span>}
            <span>{languageLabel(rel)}</span>
            <span>{crlf ? 'CRLF' : 'LF'}</span>
            <span className="ml-auto" style={{ color: dirty ? T.amber : content.truncated || !canWrite ? TERM.dim : alpha(T.green, 80) }}>
              {content.truncated
                ? 'Read-only: the file is too large to edit here (use VS Code)'
                : !canWrite
                  ? 'Read-only: restart the app to edit files here'
                  : dirty
                    ? `Unsaved changes · ${SAVE_KEY} to save`
                    : 'Saved'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
