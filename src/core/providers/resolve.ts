import type { ModelInfo, Provider } from '@shared/types'
import type { KeySource } from './keys'
import { DEFAULT_MODEL_ID, MODELS, findModel } from './models'

export interface ResolvedModel {
  model: ModelInfo
  /** Set when the configured model's provider has no key and another provider's model is used instead. */
  substituted?: { from: ModelInfo; reason: 'no-key' }
}

/** Providers that have at least one key. */
export function usableProviders(keys: KeySource): Set<Provider> {
  const out = new Set<Provider>()
  for (const m of MODELS) if (!out.has(m.provider) && keys.keysFor(m.provider).length) out.add(m.provider)
  return out
}

/**
 * The model a turn should run on: the configured one when its provider has a key, otherwise the first fast model
 * (then any model) of a provider that does. Null when no provider has a key. Never writes settings: the user's
 * choice stays, and comes back the moment its key is added.
 */
export function resolveModel(modelId: string, keys: KeySource): ResolvedModel | null {
  const wanted = findModel(modelId) ?? findModel(DEFAULT_MODEL_ID)!
  if (keys.keysFor(wanted.provider).length) return { model: wanted }
  const usable = usableProviders(keys)
  const candidates = MODELS.filter((m) => usable.has(m.provider))
  const pick = candidates.find((m) => m.fast) ?? candidates[0]
  return pick ? { model: pick, substituted: { from: wanted, reason: 'no-key' } } : null
}
