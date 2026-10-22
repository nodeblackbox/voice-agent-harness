/** A session's workspace: a live file tree with what Claude changed marked, and a viewer for the selected file. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown, ChevronRight, Code, Eye, File, FileCode, FileImage, FileText, Folder, FolderOpen, FolderSearch, Globe, RefreshCw, Search
} from 'lucide-react'
import type { CcFile, CcFileContent } from '@shared/claude'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Btn } from '../../components/primitives'
import { Markdown } from './Markdown'
import { ago, buildTree, ext, fmtBytes, isHtml, isImage, wsUrl, type Touched, type TreeNode } from './feed'

const CODE_EXT = new Set(['js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'css', 'scss', 'html', 'htm', 'json', 'py', 'rs', 'go', 'java', 'sh', 'ps1', 'yml', 'yaml', 'toml', 'xml', 'sql', 'c', 'cpp', 'h'])
const iconFor = (p: string) => (isImage(p) ? FileImage : isHtml(p) ? Globe : CODE_EXT.has(ext(p)) ? FileCode : ['md', 'txt', 'log'].includes(ext(p)) ? FileText : File)
const colorFor = (p: string) => (isHtml(p) ? '#F0883E' : ['css', 'scss'].includes(ext(p)) ? '#79C0FF' : ['js', 'mjs', 'cjs', 'jsx'].includes(ext(p)) ? '#E3C04A' : ['ts', 'tsx'].includes(ext(p)) ? '#4F9CF9' : isImage(p) ? T.green : ext(p) === 'md' ? T.text2 : T.text3)

/** Re-list the workspace now, and again shortly after the session does something. */
export function useWorkspaceFiles(id: string, pulse: unknown) {
  const [files, setFiles] = useState<CcFile[] | null>(null)
  const refresh = useCallback(async () => {
    try {
      setFiles(await window.api.claude.files(id))
    } catch {
      setFiles([])
    }
  }, [id])
  const first = useRef(true)
  useEffect(() => {
    const t = setTimeout(() => void refresh(), first.current ? 0 : 700)
    first.current = false
    return () => clearTimeout(t)
  }, [refresh, pulse])
  return { files, refresh }
}

function TreeRow({ node, depth, selected, open, toggle, select, touched }: {
  node: TreeNode
  depth: number
  selected: string | null
  open: Set<string>
  toggle: (p: string) => void
  select: (p: string) => void
  touched: Map<string, Touched>
}) {
  const isOpen = open.has(node.path)
  const t = touched.get(node.path)
  const Icon = node.dir ? (isOpen ? FolderOpen : Folder) : iconFor(node.path)
  const changedInside = node.dir && [...touched.keys()].some((p) => p.startsWith(node.path + '/'))
  return (
    <>
      <button
        type="button"
        onClick={() => (node.dir ? toggle(node.path) : select(node.path))}
        className="va-tree-row w-full flex items-center gap-1.5 text-left rounded-md"
        title={node.dir ? node.path : `${node.path} · ${fmtBytes(node.size)} · ${ago(node.mtime)}`}
        style={{ paddingLeft: 6 + depth * 14, paddingRight: 8, height: 26, cursor: 'pointer', background: selected === node.path ? T.raised : 'transparent', fontSize: 12.5 }}
      >
        {node.dir ? (isOpen ? <ChevronDown size={12} style={{ color: T.text3 }} /> : <ChevronRight size={12} style={{ color: T.text3 }} />) : <span style={{ width: 12 }} />}
        <Icon size={13} style={{ color: node.dir ? '#8AA4C8' : colorFor(node.path), flexShrink: 0 }} />
        <span className="truncate flex-1" style={{ color: node.skipped ? T.text3 : selected === node.path ? T.text : T.text2 }}>{node.name}</span>
        {t && <span className="text-xs" style={{ color: t.writes ? T.green : T.violet, fontFamily: T.mono, fontWeight: 600 }} title={`${t.writes ? 'created' : 'edited'} by Claude`}>{t.writes ? 'A' : 'M'}</span>}
        {changedInside && !isOpen && <span style={{ width: 5, height: 5, borderRadius: 5, background: T.violet }} />}
      </button>
      {node.dir && isOpen && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} selected={selected} open={open} toggle={toggle} select={select} touched={touched} />)}
      {node.dir && isOpen && node.skipped && <div className="text-xs" style={{ paddingLeft: 26 + depth * 14, color: T.text3, height: 22 }}>not listed</div>}
    </>
  )
}

function Viewer({ id, rel, mtime, onPreview }: { id: string; rel: string; mtime: number; onPreview: (rel: string) => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const [content, setContent] = useState<CcFileContent | { error: string } | null>(null)
  const [raw, setRaw] = useState(false)
  useEffect(() => {
    let live = true
    setContent(null)
    if (isImage(rel)) return
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
        {md && <Btn small icon={raw ? Eye : Code} onClick={() => setRaw(!raw)}>{raw ? 'Rendered' : 'Source'}</Btn>}
        {isHtml(rel) && <Btn small icon={Eye} onClick={() => onPreview(rel)}>Preview</Btn>}
        <Btn small icon={Globe} onClick={() => void open('default')}>Open</Btn>
        <Btn small icon={Code} onClick={() => void open('code')}>VS Code</Btn>
        <Btn small icon={FolderSearch} onClick={() => void open('reveal')}>Show</Btn>
      </div>
      <div className="va-scroll flex-1 overflow-auto p-4">
        {isImage(rel) ? (
          <div className="flex items-center justify-center rounded-xl p-6" style={{ background: 'repeating-conic-gradient(#14171b 0% 25%, #101215 0% 50%) 50% / 20px 20px', border: `1px solid ${T.border}`, minHeight: 200 }}>
            <img src={`${wsUrl(id, rel)}?v=${mtime}`} alt={rel} style={{ maxWidth: '100%', maxHeight: 480, objectFit: 'contain' }} />
          </div>
        ) : !content ? (
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
                <span style={{ color: '#3a4049', width: 48, textAlign: 'right', paddingRight: 14, userSelect: 'none', flexShrink: 0 }}>{i + 1}</span>
                <span style={{ color: '#C9D1D9', whiteSpace: 'pre', paddingRight: 16 }}>{l || ' '}</span>
              </div>
            ))}
            {content.truncated && <div className="px-4 pt-2 text-xs" style={{ color: T.text3 }}>File cut short here (it is large). Use Open to see all of it.</div>}
          </div>
        )}
      </div>
    </div>
  )
}

export function Files({ id, files, refresh, touched, selected, onSelect, onPreview }: {
  id: string
  files: CcFile[] | null
  refresh: () => void
  touched: Touched[]
  selected: string | null
  onSelect: (rel: string | null) => void
  onPreview: (rel: string) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
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
  // a filter opens everything it matched
  const openSet = filter.trim() ? new Set(shown.filter((f) => f.dir).map((f) => f.path)) : open
  // reveal the selected file's folders
  useEffect(() => {
    if (!selected?.includes('/')) return
    setOpen((o) => {
      const n = new Set(o)
      for (let p = selected; p.includes('/'); ) { p = p.slice(0, p.lastIndexOf('/')); n.add(p) }
      return n
    })
  }, [selected])
  const toggle = (p: string) => setOpen((o) => { const n = new Set(o); if (n.has(p)) n.delete(p); else n.add(p); return n })
  const fileCount = (files ?? []).filter((f) => !f.dir).length
  const sel = selected && (files ?? []).find((f) => f.path === selected)
  return (
    <div className="flex flex-1 min-h-0">
      <div className="flex flex-col" style={{ width: 270, borderRight: `1px solid ${T.border}`, background: T.rail }}>
        <div className="flex items-center gap-1.5 px-3 py-2" style={{ borderBottom: `1px solid ${T.border}` }}>
          <Search size={12} style={{ color: T.text3 }} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${fileCount} files`} className="flex-1 text-xs" style={{ background: 'transparent', color: T.text, border: 'none' }} />
          <button type="button" onClick={refresh} aria-label="Refresh files" style={{ color: T.text3, cursor: 'pointer', background: 'transparent' }}><RefreshCw size={12} /></button>
        </div>
        <div className="va-scroll flex-1 overflow-y-auto py-1.5 px-1.5">
          {files === null && <div className="text-xs p-3" style={{ color: T.text3 }}>Loading…</div>}
          {files?.length === 0 && <div className="text-xs p-3" style={{ color: T.text3, lineHeight: 1.6 }}>The folder is empty. Files appear here as Claude creates them.</div>}
          {tree.map((n) => <TreeRow key={n.path} node={n} depth={0} selected={selected} open={openSet} toggle={toggle} select={onSelect} touched={touchedMap} />)}
        </div>
      </div>
      {sel ? (
        <Viewer id={id} rel={sel.path} mtime={sel.mtime} onPreview={onPreview} />
      ) : (
        <div className="flex-1 flex flex-col gap-3 items-center justify-center" style={{ color: T.text3 }}>
          <FolderOpen size={36} style={{ opacity: 0.4 }} />
          <div className="text-sm">Pick a file to look inside.</div>
          {touched.length > 0 && (
            <div className="flex flex-col gap-1 items-center">
              <div className="text-xs">Recently changed by Claude</div>
              {touched.slice(0, 6).map((t) => (
                <button key={t.path} type="button" onClick={() => onSelect(t.path)} className="text-xs" style={{ color: T.cyan, fontFamily: T.mono, cursor: 'pointer', background: 'transparent' }}>{t.path}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
