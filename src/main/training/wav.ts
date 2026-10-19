/** Mono float samples -> 24-bit PCM WAV. Samples outside [-1, 1] are clamped. */
export function encodeWav24(samples: Float32Array, sampleRate: number): Buffer {
  const data = samples.length * 3
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20) // PCM
  b.writeUInt16LE(1, 22) // mono
  b.writeUInt32LE(sampleRate, 24)
  b.writeUInt32LE(sampleRate * 3, 28)
  b.writeUInt16LE(3, 32)
  b.writeUInt16LE(24, 34)
  b.write('data', 36)
  b.writeUInt32LE(data, 40)
  let o = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    b.writeIntLE(Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff), o, 3)
    o += 3
  }
  return b
}

/** Peak level in dBFS, rounded to 0.1; null for digital silence. */
export function peakDbfs(samples: Float32Array): number | null {
  let peak = 0
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!))
  return peak > 0 ? Math.round(200 * Math.log10(peak)) / 10 : null
}
