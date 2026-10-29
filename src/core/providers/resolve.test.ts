import { describe, expect, it } from 'vitest'
import type { Provider } from '@shared/types'
import type { KeySource } from './keys'
import { resolveModel, spareModels, usableProviders } from './resolve'

const keys = (...providers: Provider[]): KeySource => ({ keysFor: (p) => (providers.includes(p) ? ['k'] : []) })

describe('resolveModel', () => {
  it('keeps the configured model when its provider has a key', () => {
    expect(resolveModel('anthropic:claude-sonnet-5', keys('anthropic'))).toEqual({ model: expect.objectContaining({ id: 'anthropic:claude-sonnet-5' }) })
  })

  it('substitutes the first fast model of a keyed provider, remembering what was asked for', () => {
    const r = resolveModel('anthropic:claude-haiku-4-5', keys('groq'))
    expect(r?.model).toMatchObject({ provider: 'groq', fast: true })
    expect(r?.substituted).toEqual({ from: expect.objectContaining({ id: 'anthropic:claude-haiku-4-5' }), reason: 'no-key' })
  })

  it('returns null when no provider has a key', () => {
    expect(resolveModel('anthropic:claude-haiku-4-5', keys())).toBeNull()
  })

  it('falls back to the default model for an unknown id, then resolves that', () => {
    expect(resolveModel('nonsense', keys('anthropic'))?.model.id).toBe('anthropic:claude-haiku-4-5')
    expect(resolveModel('nonsense', keys('openai'))?.model.provider).toBe('openai')
  })

  it('offers one spare model per keyed provider the chain does not cover yet', () => {
    const spares = spareModels(keys('anthropic', 'groq', 'openai'), ['anthropic'])
    expect(spares.map((m) => m.provider)).toEqual(['openai', 'groq'])
    expect(spares.every((m) => m.fast)).toBe(true)
    expect(spareModels(keys('anthropic'), ['anthropic'])).toEqual([])
  })

  it('lists the providers that have keys', () => {
    expect([...usableProviders(keys('xai', 'openai'))].sort()).toEqual(['openai', 'xai'])
  })
})
