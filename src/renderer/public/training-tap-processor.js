// AudioWorklet processor for training recording mode: forwards the raw mic, untouched, as float32
// blocks at the context's native rate. Served from public/ for the same reason as capture-processor.js.
const BLOCK = 2048

class TrainingTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(BLOCK)
    this.fill = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.fill++] = ch[i]
      if (this.fill === BLOCK) {
        const out = this.buf.buffer.slice(0)
        this.port.postMessage(out, [out])
        this.fill = 0
      }
    }
    return true
  }
}

registerProcessor('va-training-tap', TrainingTapProcessor)
