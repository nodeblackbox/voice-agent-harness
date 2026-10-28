/** Pictures, videos, audio and PDFs in a session's workspace, shown as themselves: a viewer per kind and a gallery. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FileAudio, Film, Image as ImageIcon, Maximize2, Minimize2, Pause, Play, Repeat } from 'lucide-react'
import type { CcFile } from '@shared/claude'
import { T } from '../../theme'
import { ago, fmtBytes, isAudio, isImage, isPdf, isVideo, wsUrl } from './feed'

const CHECKER = 'repeating-conic-gradient(#14171b 0% 25%, #101215 0% 50%) 50% / 20px 20px'
export const VIDEO_TINT = '#F472B6'
export const AUDIO_TINT = '#22D3EE'

const clock = (s: number) => {
  if (!Number.isFinite(s)) return '–:––'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`
}

function Facts({ items }: { items: Array<string | false | null | undefined> }) {
  const shown = items.filter(Boolean) as string[]
  return (
    <div className="flex items-center justify-center gap-2 text-xs" style={{ color: T.text3, fontFamily: T.mono }}>
      {shown.map((t, i) => (
        <span key={i} className="flex items-center gap-2">
          {i > 0 && <span style={{ width: 3, height: 3, borderRadius: 3, background: T.text3, opacity: 0.6 }} />}
          {t}
        </span>
      ))}
    </div>
  )
}

function ImageView({ src, size }: { src: string; size: number }) {
  const [dims, setDims] = useState<[number, number] | null>(null)
  const [actual, setActual] = useState(false)
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="relative flex-1 min-h-0 flex items-center justify-center rounded-xl overflow-auto" style={{ background: CHECKER, border: `1px solid ${T.border}`, minHeight: 240 }}>
        <img
          src={src}
          alt=""
          onLoad={(e) => setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
          style={actual ? { maxWidth: 'none' } : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
        <button
          type="button"
          onClick={() => setActual(!actual)}
          aria-label={actual ? 'Fit to view' : 'Actual size'}
          title={actual ? 'Fit to view' : 'Actual size'}
          className="absolute top-2 right-2 rounded-md p-1.5"
          style={{ background: 'rgba(11,13,16,.75)', border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer' }}
        >
          {actual ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
      <Facts items={[dims && `${dims[0]} × ${dims[1]}`, fmtBytes(size)]} />
    </div>
  )
}

function VideoView({ src, size }: { src: string; size: number }) {
  const [meta, setMeta] = useState<{ w: number; h: number; d: number } | null>(null)
  const [loop, setLoop] = useState(false)
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="relative flex-1 min-h-0 flex items-center justify-center rounded-xl overflow-hidden" style={{ background: '#050607', border: `1px solid ${T.border}`, minHeight: 240 }}>
        <video
          key={src}
          src={src}
          controls
          preload="metadata"
          loop={loop}
          onLoadedMetadata={(e) => setMeta({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight, d: e.currentTarget.duration })}
          style={{ maxWidth: '100%', maxHeight: '100%', display: 'block' }}
        />
      </div>
      <div className="flex items-center justify-center gap-3">
        <Facts items={[meta && `${meta.w} × ${meta.h}`, meta && clock(meta.d), fmtBytes(size)]} />
        <button
          type="button"
          onClick={() => setLoop(!loop)}
          aria-pressed={loop}
          title="Loop"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
          style={{ cursor: 'pointer', color: loop ? VIDEO_TINT : T.text3, background: loop ? 'rgba(244,114,182,.10)' : 'transparent', border: `1px solid ${loop ? 'rgba(244,114,182,.35)' : T.border}` }}
        >
          <Repeat size={11} /> Loop
        </button>
      </div>
    </div>
  )
}

/** Peaks for a waveform: decoded once in the renderer (small files only; a long podcast is not worth the memory). */
function usePeaks(src: string, size: number, bars: number): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null)
  useEffect(() => {
    setPeaks(null)
    if (size > 40 * 1024 * 1024) return
    let live = true
    const ctx = new AudioContext()
    void fetch(src)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => {
        const data = buf.getChannelData(0)
        const step = Math.max(1, Math.floor(data.length / bars))
        const out: number[] = []
        for (let i = 0; i < bars; i++) {
          let peak = 0
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) peak = Math.max(peak, Math.abs(data[j]!))
          out.push(peak)
        }
        const max = Math.max(...out, 0.001)
        if (live) setPeaks(out.map((p) => p / max))
      })
      .catch(() => undefined)
      .finally(() => void ctx.close())
    return () => { live = false }
  }, [src, size, bars])
  return peaks
}

function AudioView({ src, name, size }: { src: string; name: string; size: number }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [d, setD] = useState(NaN)
  const BARS = 96
  const peaks = usePeaks(src, size, BARS)
  const flat = useMemo(() => Array.from({ length: BARS }, (_, i) => 0.25 + 0.2 * Math.abs(Math.sin(i * 0.7))), [])
  const progress = Number.isFinite(d) && d > 0 ? t / d : 0
  const toggle = () => {
    const a = audio.current
    if (!a) return
    if (a.paused) void a.play()
    else a.pause()
  }
  const seek = (e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => {
    const a = audio.current
    if (!a || !Number.isFinite(a.duration)) return
    if ('key' in e) {
      if (e.key === 'ArrowRight') a.currentTime = Math.min(a.duration, a.currentTime + 5)
      else if (e.key === 'ArrowLeft') a.currentTime = Math.max(0, a.currentTime - 5)
      else if (e.key === ' ' || e.key === 'Enter') toggle()
      else return
      e.preventDefault()
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * a.duration
  }
  return (
    <div className="flex items-center justify-center h-full p-4">
      <div className="w-full flex flex-col gap-5 rounded-2xl p-6" style={{ maxWidth: 640, background: `linear-gradient(160deg, rgba(34,211,238,.07), rgba(185,139,255,.05) 60%, transparent), ${T.surface}`, border: `1px solid ${T.border}` }}>
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center rounded-xl" style={{ width: 44, height: 44, background: 'rgba(34,211,238,.10)', border: '1px solid rgba(34,211,238,.28)' }}>
            <FileAudio size={20} style={{ color: AUDIO_TINT }} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate" style={{ color: T.text }}>{name}</div>
            <div className="text-xs" style={{ color: T.text3, fontFamily: T.mono }}>{clock(d)} · {fmtBytes(size)}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex items-center justify-center rounded-full"
            style={{ width: 46, height: 46, flexShrink: 0, cursor: 'pointer', background: AUDIO_TINT, color: '#06232a', boxShadow: '0 6px 20px rgba(34,211,238,.25)' }}
          >
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
          </button>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(Number.isFinite(d) ? d : 0)}
            aria-valuenow={Math.round(t)}
            onClick={seek}
            onKeyDown={seek}
            className="flex-1 flex items-center gap-[2px]"
            style={{ height: 48, cursor: 'pointer' }}
          >
            {(peaks ?? flat).map((p, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: `${Math.max(8, p * 100)}%`,
                  borderRadius: 2,
                  background: i / BARS < progress ? AUDIO_TINT : peaks ? '#2f3a44' : '#20262d',
                  transition: 'background .12s linear'
                }}
              />
            ))}
          </div>
        </div>
        <div className="flex justify-between text-xs" style={{ color: T.text3, fontFamily: T.mono, marginTop: -8 }}>
          <span>{clock(t)}</span>
          <span>{clock(d)}</span>
        </div>
        <audio
          ref={audio}
          src={src}
          preload="metadata"
          onLoadedMetadata={(e) => setD(e.currentTarget.duration)}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      </div>
    </div>
  )
}

/** The viewer body for a picture, video, audio file or PDF; null for anything else (the caller shows text). */
export function MediaView({ id, rel, mtime, size }: { id: string; rel: string; mtime: number; size: number }) {
  const src = `${wsUrl(id, rel)}?v=${mtime}`
  const name = rel.split('/').pop() ?? rel
  if (isImage(rel)) return <ImageView src={src} size={size} />
  if (isVideo(rel)) return <VideoView src={src} size={size} />
  if (isAudio(rel)) return <AudioView src={src} name={name} size={size} />
  if (isPdf(rel)) return <iframe title={name} src={src} className="w-full h-full rounded-xl" style={{ border: `1px solid ${T.border}`, background: '#fff', minHeight: 400 }} />
  return null
}

function Thumb({ id, f }: { id: string; f: CcFile }) {
  const video = useRef<HTMLVideoElement>(null)
  const [dur, setDur] = useState<number | null>(null)
  const src = `${wsUrl(id, f.path)}?v=${f.mtime}`
  if (isImage(f.path)) return <img src={src} alt="" loading="lazy" className="w-full h-full" style={{ objectFit: 'cover' }} />
  if (isVideo(f.path)) {
    return (
      <div
        className="relative w-full h-full"
        onMouseEnter={() => void video.current?.play().catch(() => undefined)}
        onMouseLeave={() => { const v = video.current; if (v) { v.pause(); v.currentTime = Math.min(0.5, v.duration || 0) } }}
      >
        <video ref={video} src={`${src}#t=0.5`} muted loop playsInline preload="metadata" onLoadedMetadata={(e) => setDur(e.currentTarget.duration)} className="w-full h-full" style={{ objectFit: 'cover', background: '#050607' }} />
        <span className="absolute left-2 bottom-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-xs" style={{ background: 'rgba(5,6,7,.75)', color: '#fff', fontFamily: T.mono, fontSize: 10.5 }}>
          <Play size={9} fill="currentColor" /> {dur !== null ? clock(dur) : 'video'}
        </span>
      </div>
    )
  }
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2" style={{ background: `linear-gradient(160deg, rgba(34,211,238,.10), rgba(185,139,255,.06)), ${T.raised}` }}>
      <div className="flex items-end gap-[3px]" style={{ height: 28 }}>
        {[0.4, 0.75, 0.55, 1, 0.65, 0.85, 0.45, 0.7, 0.5].map((h, i) => <span key={i} style={{ width: 3, height: `${h * 100}%`, borderRadius: 2, background: AUDIO_TINT, opacity: 0.85 }} />)}
      </div>
      <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono, fontSize: 10.5 }}>{f.path.split('.').pop()?.toUpperCase()}</span>
    </div>
  )
}

/** Every picture, video and audio file in the workspace as a grid; newest first. */
export function Gallery({ id, files, selected, onSelect }: { id: string; files: CcFile[]; selected: string | null; onSelect: (rel: string) => void }) {
  const media = useMemo(() => files.filter((f) => !f.dir && (isImage(f.path) || isVideo(f.path) || isAudio(f.path))).sort((a, b) => b.mtime - a.mtime), [files])
  const counts = { image: media.filter((f) => isImage(f.path)).length, video: media.filter((f) => isVideo(f.path)).length, audio: media.filter((f) => isAudio(f.path)).length }
  const now = Date.now()
  if (!media.length) {
    return (
      <div className="flex-1 flex flex-col gap-3 items-center justify-center" style={{ color: T.text3 }}>
        <ImageIcon size={36} style={{ opacity: 0.4 }} />
        <div className="text-sm">No pictures, videos or audio here yet.</div>
      </div>
    )
  }
  return (
    <div className="va-scroll flex-1 overflow-auto p-4">
      <div className="flex items-center gap-3 mb-3 text-xs" style={{ color: T.text3 }}>
        {counts.video > 0 && <span className="flex items-center gap-1"><Film size={12} style={{ color: VIDEO_TINT }} /> {counts.video} video{counts.video === 1 ? '' : 's'}</span>}
        {counts.image > 0 && <span className="flex items-center gap-1"><ImageIcon size={12} style={{ color: T.green }} /> {counts.image} image{counts.image === 1 ? '' : 's'}</span>}
        {counts.audio > 0 && <span className="flex items-center gap-1"><FileAudio size={12} style={{ color: AUDIO_TINT }} /> {counts.audio} audio</span>}
      </div>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 1fr))' }}>
        {media.map((f) => {
          const active = selected === f.path
          return (
            <button
              key={f.path}
              type="button"
              onClick={() => onSelect(f.path)}
              title={f.path}
              className="va-media-card text-left rounded-xl overflow-hidden flex flex-col"
              style={{ cursor: 'pointer', background: T.surface, border: `1px solid ${active ? '#D97757' : T.border}`, boxShadow: active ? '0 0 0 1px #D97757' : undefined }}
            >
              <div style={{ aspectRatio: '16 / 10', background: CHECKER, overflow: 'hidden' }}>
                <Thumb id={id} f={f} />
              </div>
              <div className="px-2.5 py-2 min-w-0">
                <div className="text-xs truncate" style={{ color: T.text }}>{f.path.split('/').pop()}</div>
                <div className="text-xs truncate" style={{ color: T.text3, fontSize: 10.5 }}>{fmtBytes(f.size)} · {ago(f.mtime, now)}{f.path.includes('/') ? ` · ${f.path.slice(0, f.path.lastIndexOf('/'))}` : ''}</div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
