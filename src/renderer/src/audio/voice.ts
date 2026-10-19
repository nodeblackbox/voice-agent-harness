import { capture } from './capture'
import { useStore } from '../state/store'
import { trainingTap } from './training-tap'
import { rlog } from '../lib/rlog'

let busy = false

export async function startListening(): Promise<void> {
  if (busy || useStore.getState().listening) return
  busy = true
  try {
    const deviceId = useStore.getState().settings?.audio.inputDeviceId
    await capture.start(deviceId)
    capture.setMuted(useStore.getState().micMuted)
    trainingTap.setMuted(useStore.getState().micMuted)
    // training recording mode only; a failure here must never cost the user their voice mode
    await trainingTap.start(deviceId).catch((err: unknown) => {
      rlog('warn', 'training', `raw tap failed: ${err instanceof Error ? err.message : String(err)}`)
      useStore.getState().pushToast('warn', 'Training recording could not open the raw mic, so this session is not being recorded.')
    })
    await window.api.voice.start()
    useStore.getState().setListening(true)
  } catch (err) {
    await trainingTap.stop()
    await capture.stop()
    useStore.getState().pushToast('error', `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    busy = false
  }
}

export async function stopListening(): Promise<void> {
  if (busy) return
  busy = true
  try {
    await window.api.voice.stop().catch(() => undefined)
    await trainingTap.stop()
    await capture.stop()
    useStore.getState().setListening(false)
  } finally {
    busy = false
  }
}

export function toggleListening(): Promise<void> {
  return useStore.getState().listening ? stopListening() : startListening()
}

/** Mute the microphone without leaving voice mode: the stream stays open, the ears hear silence. */
export function setMicMuted(v: boolean): void {
  capture.setMuted(v)
  trainingTap.setMuted(v)
  useStore.getState().setMicMuted(v)
  window.api.log.write('info', 'voice', v ? 'mic muted' : 'mic unmuted')
}

export function toggleMicMuted(): void {
  setMicMuted(!useStore.getState().micMuted)
}
