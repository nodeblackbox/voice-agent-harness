import { describe, expect, it } from 'vitest'
import type { VoiceSettings } from './types'
import { CLOUD_TTS_PROVIDERS, TTS_ENGINE_LABELS, TTS_PROVIDERS, cloudChoice, expressiveGuide, isCloudTts, modelTakesTags, requestFields } from './tts'

const voice: VoiceSettings = {
  engine: 'inworld',
  voice: 'en-US-AvaNeural',
  kokoroVoice: 'af_heart',
  rate: 0.1,
  pitch: 0,
  cloud: { inworld: { voice: 'Dennis' }, qwen: { voice: 'mine-123', model: 'qwen-audio-3.0-tts-plus', instruction: 'cheerful' } },
  expressive: true,
  proxy: { url: '', edge: false, cloud: false }
}

describe('TTS provider metadata', () => {
  it('describes every hosted provider consistently: default model and voice are in the lists, labels exist', () => {
    for (const p of CLOUD_TTS_PROVIDERS) {
      const info = TTS_PROVIDERS[p]
      expect(info.id).toBe(p)
      expect(info.models.map((m) => m.id)).toContain(info.defaultModel)
      expect(info.voices.map((v) => v.shortName)).toContain(info.defaultVoice)
      expect(info.envKeys.length).toBeGreaterThan(0)
      expect(TTS_ENGINE_LABELS[p]).toBe(info.label)
    }
    expect(isCloudTts('fish')).toBe(true)
    expect(isCloudTts('edge')).toBe(false)
  })

  it('resolves a provider choice from the setting, else the provider default', () => {
    expect(cloudChoice(voice, 'inworld')).toEqual({ voice: 'Dennis', model: 'inworld-tts-2-flash', instruction: '' })
    expect(cloudChoice(voice, 'elevenlabs')).toEqual({ voice: TTS_PROVIDERS.elevenlabs.defaultVoice, model: 'eleven_flash_v2_5', instruction: '' })
    expect(cloudChoice(voice, 'qwen')).toEqual({ voice: 'mine-123', model: 'qwen-audio-3.0-tts-plus', instruction: 'cheerful' })
  })

  it('gives each engine the voice field it understands', () => {
    expect(requestFields(voice, 'edge').voice).toBe('en-US-AvaNeural')
    expect(requestFields(voice, 'kokoro').voice).toBe('af_heart')
    expect(requestFields(voice, 'system').voice).toBe('')
    expect(requestFields(voice, 'inworld').voice).toBe('Dennis')
  })

  it('knows which models read cues aloud', () => {
    expect(modelTakesTags('elevenlabs', 'eleven_flash_v2_5')).toBe(false)
    expect(modelTakesTags('elevenlabs', 'eleven_v3')).toBe(true)
    expect(modelTakesTags('elevenlabs', 'eleven_future_model')).toBe(true) // unknown: assume the newest behaviour
    expect(modelTakesTags('inworld', 'inworld-tts-2-flash')).toBe(true)
    expect(modelTakesTags('qwen', 'qwen-audio-3.0-tts-flash')).toBe(false)
  })

  it('writes a cue guide in the provider’s own syntax, and none for Qwen', () => {
    expect(expressiveGuide('fish')).toContain('(laughing)')
    expect(expressiveGuide('inworld')).toContain('[laugh]')
    expect(expressiveGuide('qwen')).toBeUndefined()
  })
})
