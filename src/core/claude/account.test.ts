import { describe, expect, it } from 'vitest'
import { billingOf, toAccount } from './account'

describe('billing', () => {
  it('reads the CLI report', () => {
    expect(billingOf('none')).toBe('subscription')
    expect(billingOf('ANTHROPIC_API_KEY')).toBe('api-key')
    expect(billingOf('apiKeyHelper')).toBe('api-key')
    expect(billingOf('none', 'bedrock')).toBe('other')
    expect(billingOf(undefined)).toBe('unknown')
  })

  it('shapes the account: a logged-in plan, or the key that would be billed', () => {
    // the shapes the real CLI returned in lab/claude-sdk/06-auth.ts, with and without the env scrub
    expect(toAccount({ email: 'me@x.com', organization: 'Org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }))
      .toEqual({ billing: 'subscription', email: 'me@x.com', organization: 'Org', plan: 'Claude Max', keySource: undefined, provider: undefined })
    expect(toAccount({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toMatchObject({ billing: 'api-key', keySource: 'ANTHROPIC_API_KEY' })
    expect(toAccount({})).toMatchObject({ billing: 'unknown' })
  })
})
