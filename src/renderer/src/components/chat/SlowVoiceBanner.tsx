import { useState } from 'react'
import { Gauge, X } from 'lucide-react'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Btn, IconBtn } from '../primitives'
import { friendlyVoice } from './ChatHeader'

export const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`

/**
 * Above the transcript when the chosen Edge voice has been slow to start speaking. Offers the plain voice
 * of the same name when it measured quicker; otherwise points at the voice list, where each can be timed.
 */
export function SlowVoiceBanner() {
  const notice = useStore((s) => s.slowVoice)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const setView = useStore((s) => s.setView)
  const [busy, setBusy] = useState(false)
  if (!notice || !settings || settings.voice.engine !== 'edge' || settings.voice.voice !== notice.voice) return null
  const close = () => useStore.setState({ slowVoice: null })
  const twin = notice.twin
  const switchVoice = async () => {
    if (!twin) return
    setBusy(true)
    try {
      await updateSettings({ voice: { ...settings.voice, voice: twin } })
      close()
      void window.api.speak.preview(twin, 'edge')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div role="status" className="mx-4 mt-3 rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: T.amberTint, border: `1px solid ${T.amber}`, color: T.text }}>
      <Gauge size={16} style={{ color: T.amber, flexShrink: 0 }} />
      <div className="flex-1 min-w-0">
        <div className="text-sm" style={{ fontWeight: 600 }}>
          {friendlyVoice(notice.voice)} is taking about {seconds(notice.ms)} to start speaking
        </div>
        <div className="text-xs" style={{ color: T.text2 }}>
          {twin && notice.twinMs !== undefined
            ? `That is Microsoft's side for this voice, on every route. ${friendlyVoice(twin)} is the same speaker and just measured ${seconds(notice.twinMs)}.`
            : "That is Microsoft's side for this voice, on every route. Time the other voices in Settings to find a quick one."}
        </div>
      </div>
      {twin ? (
        <Btn small primary disabled={busy} onClick={() => void switchVoice()}>
          Switch to {friendlyVoice(twin)}
        </Btn>
      ) : (
        <Btn small primary onClick={() => setView('settings')}>
          Open Settings
        </Btn>
      )}
      <IconBtn icon={X} label="Keep this voice" onClick={close} />
    </div>
  )
}
