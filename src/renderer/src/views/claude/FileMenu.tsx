/**
 * Right-click menu for a file or folder in a Claude session's workspace: copy its path (full or relative),
 * put it in the next message to the session, open it, open it in VS Code, show it in the file manager.
 * One provider per session view; anything that shows a workspace path asks `useFileMenu()` for the opener.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { AtSign, ClipboardCopy, Code, Copy, Eye, FileText, Folder, FolderSearch, Globe, type LucideIcon } from 'lucide-react'
import { T, alpha } from '../../theme'
import { useStore } from '../../state/store'
import { isHtml } from './feed'

/** Absolute path of a workspace-relative one, with the workspace's own separator ('' = the workspace itself). */
export function absolutePath(workspace: string, rel: string): string {
  const sep = workspace.includes('\\') ? '\\' : '/'
  const root = workspace.replace(/[\\/]+$/, '')
  return rel ? root + sep + rel.split('/').join(sep) : root
}

/** Clipboard write that also works where the async clipboard API is refused (old Electron, unfocused window). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

type Target = { path: string; dir: boolean; x: number; y: number }
type Open = (e: ReactMouseEvent, path: string, dir?: boolean) => void

const Ctx = createContext<Open | null>(null)

/** The opener for the surrounding provider; a no-op outside one, so components still render alone. */
export function useFileMenu(): Open {
  return useContext(Ctx) ?? noop
}
const noop: Open = () => undefined

export function FileMenuProvider({ id, workspace, onPreview, onMention, children }: {
  id: string
  workspace: string
  onPreview?: (rel: string) => void
  /** Put the path into the session's message box. */
  onMention?: (rel: string) => void
  children: ReactNode
}) {
  const [target, setTarget] = useState<Target | null>(null)
  const open = useCallback<Open>((e, path, dir = false) => {
    e.preventDefault()
    e.stopPropagation()
    setTarget({ path, dir, x: e.clientX, y: e.clientY })
  }, [])
  return (
    <Ctx.Provider value={open}>
      {children}
      {target && <Menu id={id} workspace={workspace} target={target} onPreview={onPreview} onMention={onMention} onClose={() => setTarget(null)} />}
    </Ctx.Provider>
  )
}

type Item = { key: string; label: string; icon: LucideIcon; hint?: string; run: () => void | Promise<void> } | 'sep'

function Menu({ id, workspace, target, onPreview, onMention, onClose }: {
  id: string
  workspace: string
  target: Target
  onPreview?: (rel: string) => void
  onMention?: (rel: string) => void
  onClose: () => void
}) {
  const pushToast = useStore((s) => s.pushToast)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: target.x, top: target.y, ready: false })
  const name = target.path ? target.path.split('/').pop()! : (workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace)
  const abs = absolutePath(workspace, target.path)

  const items = useMemo<Item[]>(() => {
    const copy = (text: string, what: string) => async () => {
      if (await copyText(text)) pushToast('info', `Copied ${what}: ${text}`)
      else pushToast('error', `Could not copy the ${what}.`)
    }
    const openWith = (how: 'default' | 'reveal' | 'code') => async () => {
      const r = await window.api.claude.open(id, target.path, how)
      if (!r.ok) pushToast('error', r.error)
    }
    const list: Item[] = [
      { key: 'copy', label: 'Copy path', icon: Copy, hint: 'full', run: copy(abs, 'path') }
    ]
    if (target.path) {
      list.push({ key: 'copy-rel', label: 'Copy relative path', icon: ClipboardCopy, run: copy(target.path, 'relative path') })
      list.push({ key: 'copy-name', label: 'Copy name', icon: FileText, run: copy(name, 'name') })
    }
    if (onMention && target.path) list.push('sep', { key: 'mention', label: 'Mention in message', icon: AtSign, run: () => onMention(target.path) })
    list.push('sep')
    if (!target.dir && onPreview && isHtml(target.path)) list.push({ key: 'preview', label: 'Preview', icon: Eye, run: () => onPreview(target.path) })
    list.push(
      { key: 'open', label: target.dir ? 'Open folder' : 'Open', icon: target.dir ? Folder : Globe, run: openWith('default') },
      { key: 'code', label: 'Open in VS Code', icon: Code, run: openWith('code') },
      { key: 'reveal', label: 'Show in File Explorer', icon: FolderSearch, run: openWith('reveal') }
    )
    return list
  }, [abs, id, name, onMention, onPreview, pushToast, target.dir, target.path])

  // keep the menu on screen: flip left/up when it would run off the window
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const pad = 8
    const left = target.x + width + pad > window.innerWidth ? Math.max(pad, target.x - width) : target.x
    const top = target.y + height + pad > window.innerHeight ? Math.max(pad, target.y - height) : target.y
    setPos({ left, top, ready: true })
  }, [target.x, target.y])

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      const i = all.indexOf(document.activeElement as HTMLButtonElement)
      all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus()
    }
    const away = () => onClose()
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', away)
    window.addEventListener('resize', away)
    document.addEventListener('scroll', away, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', away)
      window.removeEventListener('resize', away)
      document.removeEventListener('scroll', away, true)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Actions for ${name}`}
      onContextMenu={(e) => e.preventDefault()}
      className="va-fade rounded-xl overflow-hidden"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        width: 252,
        zIndex: 60,
        background: T.raised,
        border: `1px solid ${T.border}`,
        boxShadow: `0 12px 32px ${alpha('#000000', 35)}, 0 2px 6px ${alpha('#000000', 20)}`
      }}
    >
      <div className="px-3 pt-2.5 pb-2" style={{ borderBottom: `1px solid ${T.border}` }}>
        <div className="flex items-center gap-1.5 text-xs font-medium truncate" style={{ color: T.text }}>
          {target.dir ? <Folder size={12} style={{ color: T.steel, flexShrink: 0 }} /> : <FileText size={12} style={{ color: T.text3, flexShrink: 0 }} />}
          <span className="truncate">{name}</span>
        </div>
        <div className="truncate mt-0.5" title={abs} style={{ color: T.text3, fontFamily: T.mono, fontSize: 10.5, direction: 'rtl', textAlign: 'left' }}>
          {/* rtl keeps the end of a long path (the useful part) visible; the bdi stops it reordering the slashes */}
          <bdi>{abs}</bdi>
        </div>
      </div>
      <div className="py-1">
        {items.map((it, i) =>
          it === 'sep' ? (
            <div key={`sep-${i}`} style={{ height: 1, margin: '4px 8px', background: T.border }} />
          ) : (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => { onClose(); void it.run() }}
              className="va-menu-item w-full flex items-center gap-2.5 px-3 text-left text-sm"
              style={{ height: 30, color: T.text2, background: 'transparent', cursor: 'pointer', border: 'none' }}
            >
              <it.icon size={14} style={{ color: T.text3, flexShrink: 0 }} />
              <span className="flex-1">{it.label}</span>
              {it.hint && <span className="text-xs" style={{ color: T.text3 }}>{it.hint}</span>}
            </button>
          )
        )}
      </div>
    </div>
  )
}
