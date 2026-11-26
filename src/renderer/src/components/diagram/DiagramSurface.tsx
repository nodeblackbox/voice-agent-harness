/**
 * A Mermaid diagram on screen. `fit` scales it down to the space it is given (never up past its natural
 * size); `panzoom` is the full-window view: scroll to zoom, drag to move, double-click to fit again.
 * While the code is being edited, the last picture that rendered stays up and the error is shown over it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react'
import { Maximize, Minus, Plus, TriangleAlert } from 'lucide-react'
import { T, alpha } from '../../theme'
import { renderDiagram, retheme } from '../../lib/mermaid'

interface Picture {
  svg: string
  width: number
  height: number
}

/** Re-render when the app switches between light and dark. */
function useThemeKey(): string {
  const [key, setKey] = useState(() => document.documentElement.dataset.theme ?? 'dark')
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return
    const mo = new MutationObserver(() => {
      retheme()
      setKey(document.documentElement.dataset.theme ?? 'dark')
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => mo.disconnect()
  }, [])
  return key
}

function useSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

export const dots = (): CSSProperties => ({
  backgroundImage: `radial-gradient(circle, ${alpha(T.text3, 22)} 1px, transparent 1.2px)`,
  backgroundSize: '18px 18px'
})

function ErrorStrip({ error, stale }: { error: string; stale: boolean }) {
  return (
    <div className="va-fade flex items-start gap-2 text-xs rounded-lg px-3 py-2" style={{ background: T.amberTint, color: T.text, border: `1px solid ${alpha(T.amber, 40)}`, maxWidth: 560 }}>
      <TriangleAlert size={13} style={{ color: T.amber, flexShrink: 0, marginTop: 2 }} />
      <div className="min-w-0">
        <div style={{ color: T.amber, fontWeight: 600 }}>{stale ? 'The code has an error; showing the last version that worked' : 'Mermaid could not draw this'}</div>
        <pre className="va-scroll" style={{ margin: '4px 0 0', fontFamily: T.mono, fontSize: 11, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: T.text2, maxHeight: 96, overflow: 'auto' }}>{error}</pre>
      </div>
    </div>
  )
}

export function DiagramSurface({ code, mode = 'fit', maxHeight = 520, minHeight = 120, onError }: {
  code: string
  mode?: 'fit' | 'panzoom'
  /** fit: the tallest the picture may be; a taller one is shrunk a little, then scrolls, so its text stays readable. */
  maxHeight?: number
  minHeight?: number
  onError?: (error: string | null) => void
}) {
  const theme = useThemeKey()
  const [pic, setPic] = useState<Picture | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [box, size] = useSize()
  const report = useRef(onError)
  report.current = onError
  const first = useRef(true)

  useEffect(() => {
    let live = true
    setBusy(true)
    // typing re-renders after a short pause; the first picture is drawn at once
    const t = setTimeout(
      () => {
        void renderDiagram(code).then((r) => {
          if (!live) return
          setBusy(false)
          if (r.ok) {
            setPic({ svg: r.svg, width: r.width, height: r.height })
            setError(null)
            report.current?.(null)
          } else {
            setError(r.error)
            report.current?.(r.error)
          }
        })
      },
      first.current ? 0 : 220
    )
    first.current = false
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [code, theme])

  // ---- pan and zoom (full-window view)
  const [view, setView] = useState<{ x: number; y: number; k: number } | null>(null)
  const fitView = useCallback((): { x: number; y: number; k: number } | null => {
    if (!pic || !size.w || !size.h) return null
    const k = Math.min((size.w - 48) / pic.width, (size.h - 48) / pic.height, 2.5)
    return { k, x: (size.w - pic.width * k) / 2, y: (size.h - pic.height * k) / 2 }
  }, [pic, size.w, size.h])
  const fitted = useRef(false)
  useEffect(() => {
    if (mode !== 'panzoom' || fitted.current) return
    const v = fitView()
    if (v) {
      fitted.current = true
      setView(v)
    }
  }, [mode, fitView])
  const zoom = (factor: number, cx = size.w / 2, cy = size.h / 2): void =>
    setView((v) => {
      if (!v) return v
      const k = Math.min(6, Math.max(0.15, v.k * factor))
      return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k }
    })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const down = (e: RPointerEvent<HTMLDivElement>): void => {
    if (!view || e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const up = (): void => {
    drag.current = null
  }
  const move = (e: RPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    // the button was let go somewhere the release never reached us
    if (d && e.buttons === 0) return up()
    if (d) setView((v) => (v ? { ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y } : v))
  }
  // wheel must be a non-passive listener to stop the page behind from scrolling
  useEffect(() => {
    const el = box.current
    if (mode !== 'panzoom' || !el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, size.w, size.h])

  if (mode === 'panzoom') {
    return (
      <div ref={box} className="relative w-full h-full overflow-hidden" style={{ ...dots(), cursor: drag.current ? 'grabbing' : 'grab', touchAction: 'none' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => setView(fitView())}>
        {pic && view && (
          <div className="va-diagram" style={{ position: 'absolute', left: 0, top: 0, width: pic.width, height: pic.height, transformOrigin: '0 0', transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }} dangerouslySetInnerHTML={{ __html: pic.svg }} />
        )}
        {!pic && !error && <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: T.text3 }}>Drawing…</div>}
        {error && <div className="absolute left-4 bottom-4"><ErrorStrip error={error} stale={!!pic} /></div>}
        <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-lg p-1" style={{ background: T.surface, border: `1px solid ${T.border}`, boxShadow: `0 6px 24px ${T.shadow}` }} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <ZoomBtn label="Zoom out" onClick={() => zoom(1 / 1.25)}><Minus size={14} /></ZoomBtn>
          <span className="text-xs text-center" style={{ color: T.text2, fontFamily: T.mono, minWidth: 44 }}>{view ? `${Math.round(view.k * 100)}%` : ''}</span>
          <ZoomBtn label="Zoom in" onClick={() => zoom(1.25)}><Plus size={14} /></ZoomBtn>
          <ZoomBtn label="Fit to window" onClick={() => setView(fitView())}><Maximize size={13} /></ZoomBtn>
        </div>
      </div>
    )
  }

  const k = pic && size.w ? Math.min(1, (size.w - 32) / pic.width, Math.max(maxHeight / pic.height, 0.82)) : 1
  const tall = !!pic && pic.height * k > maxHeight
  return (
    <div ref={box} className="va-scroll relative w-full flex flex-col items-center gap-3" style={{ ...dots(), minHeight, padding: '18px 16px', justifyContent: tall ? 'flex-start' : 'center', maxHeight: maxHeight + 36, overflowY: tall ? 'auto' : 'hidden' }}>
      {pic ? (
        <div className="va-diagram" data-testid="diagram-picture" style={{ width: Math.max(1, pic.width * k), height: Math.max(1, pic.height * k), flexShrink: 0, opacity: error ? 0.5 : busy ? 0.85 : 1, transition: 'opacity .15s' }} dangerouslySetInnerHTML={{ __html: pic.svg }} />
      ) : (
        !error && <div className="text-xs va-pulse" style={{ color: T.text3 }}>Drawing…</div>
      )}
      {error && <ErrorStrip error={error} stale={!!pic} />}
    </div>
  )
}

function ZoomBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="inline-flex items-center justify-center rounded-md" style={{ width: 28, height: 28, background: 'transparent', border: 'none', color: T.text2, cursor: 'pointer' }}>
      {children}
    </button>
  )
}
