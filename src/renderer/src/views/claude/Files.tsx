/** A session's workspace: a live file tree with what Claude changed marked, and a viewer for the selected file. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight, Code, Eye, File, FileAudio, FileCode, FileImage, FileJson, FileText, FileVideo, Folder, FolderOpen, FolderSearch, Globe, LayoutGrid, RefreshCw, Search
} from 'lucide-react'
import type { CcFile, CcFileContent } from '@shared/claude'
import { T, alpha, TERM } from '../../theme'
import { useStore } from '../../state/store'
import { Btn } from '../../components/primitives'
import { Markdown } from './Markdown'
import { ago, buildTree, ext, fmtBytes, isAudio, isHtml, isImage, isMedia, isPdf, isVideo, type Touched, type TreeNode } from './feed'
import { AUDIO_TINT, Gallery, MediaView, VIDEO_TINT } from './Media'

const CODE_EXT = new Set(['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'htm', 'py', 'rs', 'go', 'java', 'sh', 'ps1', 'yml', 'yaml', 'toml', 'xml', 'sql', 'c', 'cpp', 'h'])
const iconFor = (p: string) =>
  isImage(p) ? FileImage : isVideo(p) ? FileVideo : isAudio(p) ? FileAudio : isPdf(p) ? FileText : isHtml(p) ? Globe : ext(p) === 'json' ? FileJson : CODE_EXT.has(ext(p)) ? FileCode : ['md', 'txt', 'log'].includes(ext(p)) ? FileText : File
const colorFor = (p: string) =>
  isHtml(p) ? '#F0883E' : ['css', 'scss'].includes(ext(p)) ? '#79C0FF' : ['js', 'mjs', 'cjs', 'jsx'].includes(ext(p)) ? '#E3C04A' : ['ts', 'tsx'].includes(ext(p)) ? '#4F9CF9'
    : ext(p) === 'json' ? '#C6A0F6' : ext(p) === 'py' ? '#7BC4A4' : isImage(p) ? T.green : isVideo(p) ? VIDEO_TINT : isAudio(p) ? AUDIO_TINT
    : isPdf(p) ? '#F87171' : ext(p) === 'md' ? T.text2 : T.text3
const FRESH_MS = 120_000

/**
 * Re-list the workspace now, and again shortly after the session does something. `unavailable` means the
 * running app predates the file browser (its main process has no listing yet): it needs a restart.
 */
export function useWorkspaceFiles(id: string, pulse: unknown) {
  const unavailable = typeof window.api.claude?.files !== 'function'
  const [files, setFiles] = useState<CcFile[] | null>(null)
  const refresh = useCallback(async () => {
    if (typeof window.api.claude?.files !== 'function') return
    try {
      setFiles(await window.api.claude.files(id))
    } catch {
      setFiles((f) => f ?? [])
    }
  }, [id])
  const first = useRef(true)
  useEffect(() => {
    const t = setTimeout(() => void refresh(), first.current ? 0 : 700)
    first.current = false
    return () => clearTimeout(t)
  }, [refresh, pulse])
  return { files, refresh, unavailable }
}

/** Shown when the running app is older than this window (files/preview need its newer main process). */
export function RestartNotice({ what }: { what: string }) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="rounded-xl p-5 flex flex-col gap-1.5" style={{ maxWidth: 440, background: T.amberTint, border: `1px solid ${T.amber}` }}>
        <div className="text-sm font-medium" style={{ color: T.amber }}>Restart the app to load {what}</div>
        <div className="text-xs" style={{ color: T.text2, lineHeight: 1.6 }}>
          This window updated itself, but the app behind it was started before {what} existed. Close the app and run{' '}
          <code style={{ fontFamily: T.mono }}>pnpm dev</code> again.
        </div>
      </div>
    </div>
  )
}

function TreeRow({ node, depth, selected, open, toggle, select, touched, now }: {
  node: TreeNode
  depth: number
  selected: string | null
  open: Set<string>
  toggle: (p: string) => void
  select: (p: string) => void
  touched: Map<string, Touched>
  now: number
}) {
  const isOpen = open.has(node.path)
  const t = touched.get(node.path)
  const Icon = node.dir ? (isOpen ? FolderOpen : Folder) : iconFor(node.path)
  const changedInside = node.dir && [...touched.keys()].some((p) => p.startsWith(node.path + '/'))
  const fresh = !node.dir && now - node.mtime < FRESH_MS
  const active = selected === node.path
  return (
    <div>
      <button
        type="button"
        onClick={() => (node.dir ? toggle(node.path) : select(node.path))}
        className="va-tree-row group w-full flex items-center gap-1.5 text-left rounded-md"
        title={node.dir ? node.path : `${node.path} · ${fmtBytes(node.size)} · changed ${ago(node.mtime, now)}`}
        style={{
          paddingLeft: 6,
          paddingRight: 8,
          height: 28,
          cursor: 'pointer',
          background: active ? alpha(T.claude, 12) : 'transparent',
          boxShadow: active ? `inset 2px 0 0 ${T.claude}` : undefined,
          fontSize: 12.5
        }}
      >
        <ChevronRight size={12} style={{ color: T.text3, flexShrink: 0, opacity: node.dir ? 1 : 0, transform: isOpen ? 'rotate(90deg)' : undefined, transition: 'transform .15s ease' }} />
        <Icon size={14} style={{ color: node.dir ? T.steel : colorFor(node.path), flexShrink: 0 }} />
        <span className="truncate flex-1" style={{ color: node.skipped ? T.text3 : active ? T.text : T.text2, fontStyle: node.skipped ? 'italic' : undefined }}>{node.name}</span>
        {fresh && !t && <span style={{ width: 6, height: 6, borderRadius: 6, background: T.claude }} className="va-pulse" title="changed in the last 2 minutes" />}
        {node.dir ? (
          <span className="text-xs" style={{ color: T.text3, fontSize: 10.5 }}>{node.skipped ? '' : node.children.length}</span>
        ) : (
          <span className="text-xs opacity-0 group-hover:opacity-100" style={{ color: T.text3, fontSize: 10.5, fontFamily: T.mono }}>{fmtBytes(node.size)}</span>
        )}
        {t && (
          <span
            className="text-xs rounded px-1"
            style={{ color: t.writes ? T.green : T.violet, background: t.writes ? alpha(T.green, 10) : T.violetTint, fontFamily: T.mono, fontWeight: 600, fontSize: 10.5 }}
            title={`${t.writes ? 'created' : 'edited'} by Claude ${ago(t.t, now)}`}
          >
            {t.writes ? 'A' : 'M'}
          </span>
        )}
        {changedInside && !isOpen && <span style={{ width: 5, height: 5, borderRadius: 5, background: T.violet }} />}
      </button>
      {node.dir && isOpen && (
        <div style={{ marginLeft: 12, paddingLeft: 6, borderLeft: `1px solid ${T.treeGuide}` }}>
          {node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} selected={selected} open={open} toggle={toggle} select={select} touched={touched} now={now} />)}
          {node.skipped && <div className="text-xs py-1 pl-6" style={{ color: T.text3 }}>not listed (dependencies)</div>}
          {!node.skipped && node.children.length === 0 && <div className="text-xs py-1 pl-6" style={{ color: T.text3 }}>empty</div>}
        </div>
      )}
    </div>
  )
}

function Viewer({ id, rel, mtime, size, onPreview }: { id: string; rel: string; mtime: number; size: number; onPreview: (rel: string) => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const [content, setContent] = useState<CcFileContent | { error: string } | null>(null)
  const [raw, setRaw] = useState(false)
  useEffect(() => {
    let live = true
    setContent(null)
    if (isMedia(rel) || isPdf(rel)) return
    void window.api.claude.read(id, rel).then((c) => { if (live) setContent(c) })
    return () => { live = false }
  }, [id, rel, mtime])
  const open = async (how: 'default' | 'reveal' | 'code') => {
    const r = await window.api.claude.open(id, rel, how)
    if (!r.ok) pushToast('error', r.error)
  }
  const md = ext(rel) === 'md'
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: `1px solid ${T.border}` }}>
        <span className="text-xs truncate flex-1" style={{ fontFamily: T.mono, color: T.text2 }}>
          {rel.split('/').map((p, i, a) => (
            <span key={i}>
              {i > 0 && <span style={{ color: T.text3 }}> / </span>}
              <span style={{ color: i === a.length - 1 ? T.text : T.text2 }}>{p}</span>
            </span>
          ))}
        </span>
        {content && 'size' in content && <span className="text-xs" style={{ color: T.text3 }}>{fmtBytes(content.size)}</span>}
        {(isMedia(rel) || isPdf(rel)) && <span className="text-xs" style={{ color: T.text3 }}>{fmtBytes(size)}</span>}
        {md && <Btn small icon={raw ? Eye : Code} onClick={() => setRaw(!raw)}>{raw ? 'Rendered' : 'Source'}</Btn>}
        {isHtml(rel) && <Btn small icon={Eye} onClick={() => onPreview(rel)}>Preview</Btn>}
        <Btn small icon={Globe} onClick={() => void open('default')}>Open</Btn>
        <Btn small icon={Code} onClick={() => void open('code')}>VS Code</Btn>
        <Btn small icon={FolderSearch} onClick={() => void open('reveal')}>Show</Btn>
      </div>
      {isMedia(rel) || isPdf(rel) ? (
        <div className="flex-1 min-h-0 flex flex-col p-4">
          <MediaView id={id} rel={rel} mtime={mtime} size={size} />
        </div>
      ) : (
      <div className="va-scroll flex-1 overflow-auto p-4">
        {!content ? (
          <div className="text-xs" style={{ color: T.text3 }}>Loading…</div>
        ) : 'error' in content ? (
          <div className="text-xs" style={{ color: T.red }}>{content.error}</div>
        ) : content.kind === 'binary' ? (
          <div className="text-sm" style={{ color: T.text3 }}>Binary file ({fmtBytes(content.size)}). Use Open to view it.</div>
        ) : md && !raw ? (
          <div style={{ maxWidth: 760 }}><Markdown text={content.text} /></div>
        ) : (
          <div className="va-term rounded-xl" style={{ border: `1px solid ${T.border}`, fontSize: 12, lineHeight: 1.6, padding: '8px 0', minWidth: 'fit-content' }}>
            {content.text.split('\n').map((l, i) => (
              <div key={i} className="va-code-line flex">
                <span style={{ color: TERM.gutter, width: 48, textAlign: 'right', paddingRight: 14, userSelect: 'none', flexShrink: 0 }}>{i + 1}</span>
                <span style={{ color: TERM.text, whiteSpace: 'pre', paddingRight: 16 }}>{l || ' '}</span>
              </div>
            ))}
            {content.truncated && <div className="px-4 pt-2 text-xs" style={{ color: T.text3 }}>File cut short here (it is large). Use Open to see all of it.</div>}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

export function Files({ id, workspace, files, refresh, unavailable, touched, selected, onSelect, onPreview }: {
  id: string
  workspace: string
  files: CcFile[] | null
  refresh: () => void
  unavailable?: boolean
  touched: Touched[]
  selected: string | null
  onSelect: (rel: string | null) => void
  onPreview: (rel: string) => void
}) {
  const pushToast = useStore((s) => s.pushToast)
  const [open, setOpen] = useState<Set<string> | null>(null)
  const [filter, setFilter] = useState('')
  const [gallery, setGallery] = useState(false)
  const now = Date.now()
  const touchedMap = useMemo(() => new Map(touched.map((t) => [t.path, t])), [touched])
  const shown = useMemo(() => {
    const list = files ?? []
    if (!filter.trim()) return list
    const q = filter.toLowerCase()
    const keep = new Set<string>()
    for (const f of list) if (!f.dir && f.path.toLowerCase().includes(q)) {
      keep.add(f.path)
      for (let p = f.path; p.includes('/'); ) { p = p.slice(0, p.lastIndexOf('/')); keep.add(p) }
    }
    return list.filter((f) => keep.has(f.path))
  }, [files, filter])
  const tree = useMemo(() => buildTree(shown), [shown])
  // first load: open the top folders of a small tree so it reads at a glance
  useEffect(() => {
    if (open || !files) return
    setOpen(new Set(files.length <= 200 ? files.filter((f) => f.dir && !f.skipped && f.path.split('/').length <= 2).map((f) => f.path) : []))
  }, [files, open])
  const openSet = filter.trim() ? new Set(shown.filter((f) => f.dir).map((f) => f.path)) : (open ?? new Set<string>())
  // reveal the selected file's folders
  useEffect(() => {
    if (!selected?.includes('/')) return
    setOpen((o) => {
      const n = new Set(o ?? [])
      for (let p = selected; p.includes('/'); ) { p = p.slice(0, p.lastIndexOf('/')); n.add(p) }
      return n
    })
  }, [selected])
  // nothing picked yet: show the file Claude touched last, or the main page
  useEffect(() => {
    if (selected || !files?.length) return
    const pick =
      touched.find((t) => files.some((f) => f.path === t.path))?.path ??
      files.find((f) => /^index\.html?$/i.test(f.path))?.path ??
      files.find((f) => !f.dir && /^readme/i.test(f.path))?.path
    if (pick) onSelect(pick)
  }, [files, selected, touched, onSelect])
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o ?? []); if (n.has(p)) n.delete(p); else n.add(p); return n })

  if (unavailable) return <RestartNotice what="the file browser" />

  const all = files ?? []
  const fileCount = all.filter((f) => !f.dir).length
  const folderCount = all.filter((f) => f.dir).length
  const total = all.reduce((n, f) => n + f.size, 0)
  const sel = selected && all.find((f) => f.path === selected)
  const folderName = workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace
  const mediaCount = all.filter((f) => !f.dir && isMedia(f.path)).length
  const openFolder = async () => {
    const r = await window.api.claude.open(id, '', 'default')
    if (!r.ok) pushToast('error', r.error)
  }
  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex flex-col" style={{ width: 300, borderRight: `1px solid ${T.border}`, background: T.rail, flexShrink: 0 }}>
        <div className="px-3 pt-3 pb-2.5 flex flex-col gap-2.5" style={{ borderBottom: `1px solid ${T.border}` }}>
          <div className="flex items-center gap-2.5">
            <div className="flex items-center justify-center rounded-lg" style={{ width: 32, height: 32, background: alpha(T.steel, 10), border: `1px solid ${alpha(T.steel, 22)}`, flexShrink: 0 }}>
              <FolderOpen size={16} style={{ color: T.steel }} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate" style={{ color: T.text }} title={workspace}>{folderName}</div>
              <div className="text-xs truncate" style={{ color: T.text3 }}>
                {files === null ? 'Reading…' : `${fileCount} file${fileCount === 1 ? '' : 's'}${folderCount ? ` · ${folderCount} folder${folderCount === 1 ? '' : 's'}` : ''} · ${fmtBytes(total)}`}
              </div>
            </div>
            {mediaCount > 0 && (
              <button
                type="button"
                onClick={() => setGallery(!gallery)}
                aria-pressed={gallery}
                aria-label="Media gallery"
                title={`Pictures, videos and audio (${mediaCount})`}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs"
                style={{ cursor: 'pointer', color: gallery ? T.claude : T.text3, background: gallery ? alpha(T.claude, 12) : 'transparent', fontFamily: T.mono, fontSize: 10.5 }}
              >
                <LayoutGrid size={13} /> {mediaCount}
              </button>
            )}
            <button type="button" onClick={refresh} aria-label="Refresh files" title="Refresh" className="rounded-md p-1.5" style={{ color: T.text3, cursor: 'pointer', background: 'transparent' }}>
              <RefreshCw size={13} />
            </button>
            <button type="button" onClick={() => void openFolder()} aria-label="Open folder" title="Open in File Explorer" className="rounded-md p-1.5" style={{ color: T.text3, cursor: 'pointer', background: 'transparent' }}>
              <FolderSearch size={13} />
            </button>
          </div>
          {touched.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs" style={{ color: T.text3 }}>
              <span className="rounded px-1" style={{ color: T.green, background: alpha(T.green, 10), fontFamily: T.mono, fontWeight: 600, fontSize: 10.5 }}>A</span>
              {touched.filter((t) => t.writes).length} created
              <span className="rounded px-1 ml-1.5" style={{ color: T.violet, background: T.violetTint, fontFamily: T.mono, fontWeight: 600, fontSize: 10.5 }}>M</span>
              {touched.filter((t) => !t.writes).length} edited by Claude
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
            <Search size={12} style={{ color: T.text3 }} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" className="flex-1 text-xs" style={{ background: 'transparent', color: T.text, border: 'none' }} />
          </div>
        </div>
        <div className="va-scroll flex-1 overflow-y-auto py-2 px-2">
          {files === null && <div className="text-xs p-3" style={{ color: T.text3 }}>Loading…</div>}
          {files?.length === 0 && (
            <div className="flex flex-col items-center gap-2 text-center px-4 py-10" style={{ color: T.text3 }}>
              <Folder size={28} style={{ opacity: 0.4 }} />
              <div className="text-xs" style={{ lineHeight: 1.6 }}>The folder is empty. Files appear here, live, as Claude creates them.</div>
            </div>
          )}
          {filter.trim() && files && shown.length === 0 && <div className="text-xs p-3" style={{ color: T.text3 }}>No file matches “{filter}”.</div>}
          {tree.map((n) => <TreeRow key={n.path} node={n} depth={0} selected={selected} open={openSet} toggle={toggle} select={(p) => { setGallery(false); onSelect(p) }} touched={touchedMap} now={now} />)}
        </div>
      </div>
      {gallery ? (
        <Gallery id={id} files={all} selected={selected} onSelect={(p) => { setGallery(false); onSelect(p) }} />
      ) : sel ? (
        <Viewer id={id} rel={sel.path} mtime={sel.mtime} size={sel.size} onPreview={onPreview} />
      ) : (
        <div className="flex-1 flex flex-col gap-3 items-center justify-center" style={{ color: T.text3 }}>
          <FolderOpen size={36} style={{ opacity: 0.4 }} />
          <div className="text-sm">Pick a file to look inside.</div>
        </div>
      )}
    </div>
  )
}
