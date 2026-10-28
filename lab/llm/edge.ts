// Is Edge TTS answering right now? pnpm tsx lab/llm/edge.ts [n]
import { EdgeTtsEngine } from '../../src/core/speech/tts'
const n = Number(process.argv[2] ?? 3)
const e = new EdgeTtsEngine(1, 8000)
for (let i = 0; i < n; i++) {
  const t0 = performance.now()
  try {
    const buf = await e.synth({ text: `Edge check number ${i + 1}.`, voice: 'en-US-AvaMultilingualNeural', rate: 0, pitch: 0 } as never, new AbortController().signal)
    console.log(`ok ${buf?.length ?? 0} bytes in ${Math.round(performance.now() - t0)}ms`)
  } catch (err) {
    console.log(`fail in ${Math.round(performance.now() - t0)}ms: ${(err as Error).message}`)
  }
}
process.exit(0)
