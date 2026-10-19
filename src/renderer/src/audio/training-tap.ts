import { rlog } from '../lib/rlog'

// Training recording mode (RECORD_TRAINING_DATA=1 in .env): a second, raw stream from the same mic,
// with echo cancellation, noise suppression and auto gain off and no resampling, sent to main for
// the voice-clone dataset. The ears keep their own processed 16 kHz stream; nothing here touches it.

let ctx: AudioContext | null = null
let stream: MediaStream | null = null
let node: AudioWorkletNode | null = null
let muted = false

export const trainingTap = {
  async start(deviceId?: string): Promise<void> {
    if (stream || !(await window.api.training.config()).enabled) return
    const media = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { ideal: deviceId } : undefined,
        channelCount: 1,
        sampleRate: { ideal: 48000 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    })
    const track = media.getAudioTracks()[0]
    const s = track?.getSettings() ?? {}
    // run the context at the mic's own rate so the browser does not resample the recording
    const c = new AudioContext({ sampleRate: s.sampleRate || 48000, latencyHint: 'interactive' })
    await c.audioWorklet.addModule(new URL('training-tap-processor.js', document.baseURI).href)
    const source = c.createMediaStreamSource(media)
    const worklet = new AudioWorkletNode(c, 'va-training-tap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => window.api.training.sendFrame(muted ? new ArrayBuffer(e.data.byteLength) : e.data)
    source.connect(worklet)
    if (c.state === 'suspended') await c.resume()
    ctx = c
    stream = media
    node = worklet
    const processing = { echoCancellation: s.echoCancellation, noiseSuppression: s.noiseSuppression, autoGainControl: s.autoGainControl, trackSampleRate: s.sampleRate }
    await window.api.training.tapStart({ sampleRate: c.sampleRate, device: track?.label ?? 'unknown', processing })
    rlog('info', 'training', `raw tap open: ${track?.label ?? 'unknown'} rate=${c.sampleRate} aec=${String(s.echoCancellation)} ns=${String(s.noiseSuppression)} agc=${String(s.autoGainControl)}`)
  },

  async stop(): Promise<void> {
    if (!stream) return
    window.api.training.tapStop()
    node?.port.close()
    node?.disconnect()
    node = null
    stream.getTracks().forEach((t) => t.stop())
    stream = null
    const c = ctx
    ctx = null
    if (c) await c.close().catch(() => undefined)
  },

  /** Mic mute applies here too: the recording gets silence, never what was said while muted. */
  setMuted(v: boolean): void {
    muted = v
  }
}
