import { createAnthropic } from '@ai-sdk/anthropic'
import { createGroq } from '@ai-sdk/groq'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogle } from '@ai-sdk/google'
import { createXai } from '@ai-sdk/xai'
import type { LanguageModel } from 'ai'
import type { ModelInfo } from '@shared/types'
import type { KeySource } from './keys'
import { GroqKeyPool } from './keys'
import { ModelCapacity } from './capacity'

export class MissingKeyError extends Error {
  constructor(readonly provider: ModelInfo['provider']) {
    super(`No API key configured for ${provider}`)
  }
}

export class ModelFactory {
  readonly groqPool: GroqKeyPool
  readonly capacity = new ModelCapacity()

  /** Keys a provider answered 401/403 for, as `provider\0key`. A replaced key is a new entry, so it is tried again. */
  private readonly rejected = new Set<string>()

  constructor(private readonly keys: KeySource) {
    this.groqPool = new GroqKeyPool(keys)
  }

  private currentKey(info: ModelInfo): string | undefined {
    return info.provider === 'groq' ? undefined : this.keys.keysFor(info.provider)[0]
  }

  /**
   * The key this model would use was already refused this run (Groq keys are benched by the pool instead).
   * Saves a doomed round trip and a toast on every turn while a revoked key sits in .env or Settings.
   */
  keyRejected(info: ModelInfo): boolean {
    const key = this.currentKey(info)
    return key !== undefined && this.rejected.has(`${info.provider}\0${key}`)
  }

  /** Remember that the provider refused the key this model uses. */
  rejectKey(info: ModelInfo): void {
    const key = this.currentKey(info)
    if (key !== undefined) this.rejected.add(`${info.provider}\0${key}`)
  }

  create(info: ModelInfo): { model: LanguageModel; key: string } {
    const key = info.provider === 'groq' ? this.groqPool.pick() : this.keys.keysFor(info.provider)[0]
    if (!key) throw new MissingKeyError(info.provider)
    switch (info.provider) {
      case 'anthropic':
        return { model: createAnthropic({ apiKey: key, headers: this.keys.headersFor?.('anthropic') })(info.model), key }
      case 'openai':
        return { model: createOpenAI({ apiKey: key })(info.model), key }
      case 'groq':
        return { model: createGroq({ apiKey: key })(info.model), key }
      case 'google':
        return { model: createGoogle({ apiKey: key })(info.model), key }
      case 'xai':
        return { model: createXai({ apiKey: key })(info.model), key }
    }
  }
}
