import type { ModelInfo, Provider } from '@shared/types'

export const PROVIDER_LABELS: Record<Provider, string> = {
  anthropic: 'Anthropic',
  groq: 'Groq',
  google: 'Google',
  xai: 'xAI'
}

const m = (provider: Provider, model: string, label: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `${provider}:${model}`,
  provider,
  providerLabel: PROVIDER_LABELS[provider],
  model,
  label,
  ...extra
})

export const MODELS: ModelInfo[] = [
  m('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', { fast: true, note: 'Default. Fast, cheap, good.' }),
  m('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', { fast: true, effort: true, note: 'Newest Haiku: fast and very cheap. The default backup.' }),
  m('anthropic', 'claude-sonnet-5', 'Claude Sonnet 5', { effort: true, note: 'Smarter, slower.' }),
  m('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', { effort: true, note: 'Newest Sonnet: smarter, slower.' }),
  m('anthropic', 'claude-opus-5', 'Claude Opus 5', { effort: true, note: 'Best reasoning, slowest.' }),
  m('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', { effort: true, note: 'Newest Opus: best reasoning, slowest.' }),
  m('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B', { fast: true, reasoning: true, note: 'Very fast on Groq.' }),
  m('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B', { reasoning: true }),
  m('groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B'),
  m('google', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', { fast: true }),
  m('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash'),
  m('xai', 'grok-4-fast-non-reasoning', 'Grok 4 Fast', { fast: true }),
  m('xai', 'grok-4', 'Grok 4')
]

export const DEFAULT_MODEL_ID = 'anthropic:claude-haiku-4-5'
export const DEFAULT_FALLBACK_MODEL_ID = 'anthropic:claude-haiku-5-5'
/** The backup earlier builds defaulted to; a stored value equal to it was never chosen, so it moves to the new default. */
export const OLD_FALLBACK_MODEL_IDS = ['groq:openai/gpt-oss-20b']

export function findModel(id: string): ModelInfo | undefined {
  const known = MODELS.find((x) => x.id === id)
  if (known) return known
  const sep = id.indexOf(':')
  if (sep < 0) return undefined
  const provider = id.slice(0, sep) as Provider
  if (!(provider in PROVIDER_LABELS)) return undefined
  const model = id.slice(sep + 1)
  return m(provider, model, model)
}
