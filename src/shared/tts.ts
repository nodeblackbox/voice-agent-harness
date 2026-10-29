import type { CloudTtsProvider, TtsEngineId, TtsModelInfo, VoiceInfo, VoiceSettings } from './types'

/**
 * The hosted voice providers: what to call them, which .env variables configure them, the models and voices
 * known to work, and the delivery-cue syntax each understands. Shared by main (keys, defaults), core (engines,
 * prompt) and the renderer (pickers). Live listings (voices, models) come from the engines' `catalog()`.
 */
export interface TtsProviderInfo {
  id: CloudTtsProvider
  label: string
  /** API key variables, first one wins. */
  envKeys: string[]
  /** .env defaults for the voice and model (the Settings value wins when set). */
  envVoice: string
  envModel: string
  envInstruction?: string
  defaultVoice: string
  defaultModel: string
  models: TtsModelInfo[]
  /** Built-in voices shown before the live listing arrives (or when it fails). */
  voices: VoiceInfo[]
  /** What the voice field holds, for the picker's placeholder. */
  voiceHint: string
  /** The engine honours the pitch slider. */
  pitch: boolean
  /** Inline delivery cues the model may write when `voice.expressive` is on; null = none (Qwen takes an instruction instead). */
  tags: { open: string; close: string; cues: string[]; note: string } | null
}

const v = (shortName: string, name: string, gender: string, locale = 'en-US'): VoiceInfo => ({ name, shortName, locale, gender })

export const TTS_PROVIDERS: Record<CloudTtsProvider, TtsProviderInfo> = {
  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    envKeys: ['ELEVENLABS_API_KEY', 'ELEVEN_LABS_API_KEY', 'XI_API_KEY'],
    envVoice: 'ELEVENLABS_VOICE_ID',
    envModel: 'ELEVENLABS_MODEL',
    defaultVoice: 'EXAVITQu4vr4xnSDxMaL',
    defaultModel: 'eleven_flash_v2_5',
    models: [
      { id: 'eleven_flash_v2_5', label: 'Flash v2.5', note: 'fastest, cheapest' },
      { id: 'eleven_v4_turbo', label: 'v4 Turbo', note: 'fast, understands cues', tags: true },
      { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5' },
      { id: 'eleven_v3', label: 'v3', note: 'most expressive, slower', tags: true },
      { id: 'eleven_v4', label: 'v4', note: 'expressive', tags: true },
      { id: 'eleven_multilingual_v2', label: 'Multilingual v2' }
    ],
    voices: [
      v('EXAVITQu4vr4xnSDxMaL', 'Sarah', 'female'),
      v('hpp4J3VqNfWAUOO0d1Us', 'Bella', 'female'),
      v('FGY2WhTYpPnrIDTdsKH5', 'Laura', 'female'),
      v('CwhRBWXzGAHq8TQ4Fs17', 'Roger', 'male')
    ],
    voiceHint: 'voice id (Voices page, or a cloned voice)',
    pitch: false,
    tags: {
      open: '[',
      close: ']',
      cues: ['laughs', 'chuckles', 'sighs', 'whispers', 'excited', 'curious', 'sarcastic', 'pause'],
      note: 'v3 and v4 models only; the Flash and Turbo v2.5 models read them aloud, so they are removed for those.'
    }
  },
  fish: {
    id: 'fish',
    label: 'Fish Audio',
    envKeys: ['FISH_API_KEY', 'FISH_AUDIO_API_KEY'],
    envVoice: 'FISH_VOICE_ID',
    envModel: 'FISH_MODEL',
    defaultVoice: '933563129e564b19a115bedd57b7406a',
    defaultModel: 's2.1-pro-free',
    models: [
      { id: 's2.1-pro-free', label: 'S2.1 Pro (free tier)', note: 'no credit needed', tags: true },
      { id: 's2.1-pro', label: 'S2.1 Pro', tags: true },
      { id: 's2-pro', label: 'S2 Pro', tags: true },
      { id: 's1', label: 'S1', tags: true },
      { id: 'drama-3', label: 'Drama 3', note: 'multi-speaker', tags: true }
    ],
    voices: [v('933563129e564b19a115bedd57b7406a', 'Sarah', 'female')],
    voiceHint: 'voice model id (your own clones are listed)',
    pitch: false,
    tags: {
      open: '(',
      close: ')',
      cues: ['laughing', 'chuckling', 'sighing', 'whispering', 'excited', 'surprised', 'sad', 'in a hurry tone', 'soft tone'],
      note: 'Written before the words they colour.'
    }
  },
  inworld: {
    id: 'inworld',
    label: 'Inworld',
    envKeys: ['INWORLD_API_KEY'],
    envVoice: 'INWORLD_VOICE_ID',
    envModel: 'INWORLD_MODEL',
    defaultVoice: 'Hana',
    defaultModel: 'inworld-tts-2-flash',
    models: [
      { id: 'inworld-tts-2-flash', label: 'TTS-2 Flash', note: 'fastest; non-verbal cues only', tags: true },
      { id: 'inworld-tts-2', label: 'TTS-2', note: 'cues and free-text delivery instructions', tags: true }
    ],
    voices: [v('Hana', 'Hana', 'female'), v('Ashley', 'Ashley', 'female'), v('Dennis', 'Dennis', 'male'), v('Olivia', 'Olivia', 'female'), v('Ethan', 'Ethan', 'male')],
    voiceHint: 'voice name (Hana, Ashley …) or a cloned voice id',
    pitch: false,
    tags: {
      open: '[',
      close: ']',
      cues: ['laugh', 'chuckle', 'sigh', 'breathe', 'gasp', 'clear throat'],
      note: 'Non-verbal sounds go exactly where they happen. On TTS-2 a free-text instruction like [say it warmly] also works and lasts until [reset].'
    }
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen (Alibaba)',
    envKeys: ['DASHSCOPE_API_KEY'],
    envVoice: 'QWEN_VOICE_ID',
    envModel: 'QWEN_MODEL',
    envInstruction: 'QWEN_INSTRUCTION',
    defaultVoice: 'longanhuan_v3.6',
    defaultModel: 'qwen-audio-3.0-tts-flash',
    models: [
      { id: 'qwen-audio-3.0-tts-flash', label: 'Qwen-Audio 3.0 TTS Flash', note: 'fast' },
      { id: 'qwen-audio-3.0-tts-plus', label: 'Qwen-Audio 3.0 TTS Plus', note: 'higher quality' }
    ],
    voices: [v('longanhuan_v3.6', 'Longanhuan', 'female', 'zh-CN')],
    voiceHint: 'preset name, or a cloned/designed voice id from Model Studio',
    pitch: true,
    tags: null
  }
}

export const CLOUD_TTS_PROVIDERS = Object.keys(TTS_PROVIDERS) as CloudTtsProvider[]

export const isCloudTts = (engine: string): engine is CloudTtsProvider => engine in TTS_PROVIDERS

/** Extra variable for Qwen: the workspace WebSocket host (the console shows it; the default is the public Singapore one). */
export const QWEN_HOST_ENV = 'DASHSCOPE_HOST'
export const QWEN_DEFAULT_HOST = 'dashscope-intl.aliyuncs.com'

export const TTS_ENGINE_LABELS: Record<TtsEngineId, string> = {
  edge: 'Edge TTS',
  kokoro: 'Kokoro (local)',
  system: 'Windows voice',
  elevenlabs: TTS_PROVIDERS.elevenlabs.label,
  fish: TTS_PROVIDERS.fish.label,
  inworld: TTS_PROVIDERS.inworld.label,
  qwen: TTS_PROVIDERS.qwen.label
}

/** The voice, model and instruction a hosted engine should use: the setting, else the provider default. */
export function cloudChoice(voice: VoiceSettings, provider: CloudTtsProvider): { voice: string; model: string; instruction: string } {
  const info = TTS_PROVIDERS[provider]
  const c = voice.cloud?.[provider] ?? {}
  return { voice: c.voice?.trim() || info.defaultVoice, model: c.model?.trim() || info.defaultModel, instruction: c.instruction?.trim() ?? '' }
}

/** Fields of a TTS request for `engine`: which voice/model it should speak with. */
export function requestFields(voice: VoiceSettings, engine: TtsEngineId): { voice: string; model: string; instruction: string } {
  if (engine === 'edge') return { voice: voice.voice, model: '', instruction: '' }
  if (engine === 'kokoro') return { voice: voice.kokoroVoice, model: '', instruction: '' }
  if (engine === 'system') return { voice: '', model: '', instruction: '' }
  return cloudChoice(voice, engine)
}

/** True when the model named for `provider` understands inline cues. */
export function modelTakesTags(provider: CloudTtsProvider, model: string): boolean {
  const info = TTS_PROVIDERS[provider]
  if (!info.tags) return false
  const known = info.models.find((m) => m.id === model)
  return known ? !!known.tags : true
}

/** Text the system prompt gets when expressive cues are on: the syntax and the cues this voice knows. */
export function expressiveGuide(provider: CloudTtsProvider): string | undefined {
  const t = TTS_PROVIDERS[provider].tags
  if (!t) return undefined
  const cues = t.cues.map((c) => `${t.open}${c}${t.close}`).join(', ')
  return `Delivery cues: the voice engine understands cues written inline, like ${cues}. Use one only when it genuinely fits the moment (a real laugh, a sigh before bad news), at most one or two per reply, placed right before the words it colours, and never as a label for every sentence. ${t.note} They are the one exception to the rule about square brackets and parentheses: the app passes them to the voice and does not speak them.`
}
