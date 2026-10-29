/**
 * Live preview of the web pages a session builds. The page is served from its workspace over `ccws://`
 * (so its own CSS, scripts and images load) inside a sandboxed frame: scripts run, but the page cannot
 * reach the app, open windows, or navigate it. Reloads by itself when Claude changes a file.
 */
import { useEffect, useState } from 'react'
import { ExternalLink, Monitor, RefreshCw, Smartphone, Tablet, Zap } from 'lucide-react'
import type { CcFile } from '@shared/claude'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Btn } from '../../components/primitives'
import { ClaudeMark } from './ClaudeMark'
import { isHtml, wsUrl } from './feed'

const DEVICES = [
  { id: 'desktop', icon: Monitor, width: 0, label: 'Desktop' },
  { id: 'tablet', icon: Tablet, width: 768, label: 'Tablet' },
  { id: 'phone', icon: Smartphone, width: 390, label: 'Phone' }
] as const

export function Preview({ id, files, page, onPage, pulse }: { id: string; files: CcFile[] | null; page: string | null; onPage: (rel: string) => void; pulse: number }) {
  const pushToast = useStore((s) => s.pushToast)
  const pages = (files ?? []).filter((f) => !f.dir && isHtml(f.path)).map((f) => f.path)
  const current = page && pages.includes(page) ? page : (pages.find((p) => /(^|\/)index\.html?$/i.test(p)) ?? pages[0] ?? null)
  const [device, setDevice] = useState<(typeof DEVICES)[number]['id']>('desktop')
  const [live, setLive] = useState(true)
  const [nonce, setNonce] = useState(0)
  // a change in the workspace (pulse) reloads the frame while live
  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => setNonce((n) => n + 1), 900)
    return () => clearTimeout(t)
  }, [pulse, live])

  if (!current) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: T.text3 }}>
        <ClaudeMark size={36} />
        <div className="text-sm">No web page in this workspace yet.</div>
        <div className="text-xs">Ask it to build one, e.g. “make a landing page in index.html”. It shows up here live.</div>
      </div>
    )
  }
  const width = DEVICES.find((d) => d.id === device)!.width
  const open = async () => {
    const r = await window.api.claude.open(id, current, 'default')
    if (!r.ok) pushToast('error', r.error)
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-4 py-2" style={{ borderBottom: `1px solid ${T.border}` }}>
        <div className="flex items-center flex-1 min-w-0 gap-2 rounded-lg px-2.5 py-1" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
          <span style={{ width: 7, height: 7, borderRadius: 7, background: live ? T.green : T.text3 }} className={live ? 'va-pulse' : undefined} />
          {pages.length > 1 ? (
            <select value={current} onChange={(e) => onPage(e.target.value)} className="flex-1 text-xs" style={{ background: 'transparent', color: T.text2, border: 'none', fontFamily: T.mono }}>
              {pages.map((p) => <option key={p} value={p} style={{ background: T.surface }}>{p}</option>)}
            </select>
          ) : (
            <span className="text-xs truncate flex-1" style={{ color: T.text2, fontFamily: T.mono }}>{current}</span>
          )}
        </div>
        <div className="flex rounded-lg overflow-hidden" style={{ border: `1px solid ${T.border}` }}>
          {DEVICES.map((d) => (
            <button key={d.id} type="button" title={d.label} aria-label={d.label} onClick={() => setDevice(d.id)} className="px-2 py-1" style={{ background: device === d.id ? T.raised : 'transparent', color: device === d.id ? T.text : T.text3, cursor: 'pointer' }}>
              <d.icon size={13} />
            </button>
          ))}
        </div>
        <Btn small icon={Zap} onClick={() => setLive(!live)}>{live ? 'Live' : 'Paused'}</Btn>
        <Btn small icon={RefreshCw} onClick={() => setNonce((n) => n + 1)}>Reload</Btn>
        <Btn small icon={ExternalLink} onClick={() => void open()}>Browser</Btn>
      </div>
      <div className="flex-1 min-h-0 flex justify-center p-3" style={{ background: `radial-gradient(ellipse at top, ${T.raised}, ${T.bg} 70%)` }}>
        <iframe
          key={`${current}-${nonce}`}
          title="Preview"
          src={`${wsUrl(id, current)}?v=${nonce}`}
          sandbox="allow-scripts allow-forms allow-pointer-lock"
          className="va-fade"
          style={{ width: width || '100%', maxWidth: '100%', height: '100%', border: `1px solid ${T.border}`, borderRadius: width ? 18 : 10, background: '#fff', boxShadow: `0 20px 60px ${T.shadow}` }}
        />
      </div>
    </div>
  )
}
