import type { CcAccount, CcBilling } from '@shared/claude'

/** What the CLI bills, from its own report. `apiKeySource` 'none' means the claude.ai login (or a 3P provider). */
export function billingOf(apiKeySource: unknown, apiProvider?: unknown): CcBilling | 'unknown' {
  if (apiProvider && apiProvider !== 'firstParty') return 'other'
  if (typeof apiKeySource === 'string' && apiKeySource && apiKeySource !== 'none') return 'api-key'
  if (apiKeySource === 'none') return 'subscription'
  return 'unknown'
}

/** The SDK's AccountInfo, shaped for the UI. With a key in use the CLI reports no email/plan. */
export function toAccount(info: { email?: string; organization?: string; subscriptionType?: string; apiKeySource?: string; apiProvider?: string }): CcAccount {
  const billing = billingOf(info.apiKeySource ?? (info.subscriptionType || info.email ? 'none' : undefined), info.apiProvider)
  return {
    billing,
    email: info.email,
    organization: info.organization,
    plan: info.subscriptionType,
    keySource: billing === 'api-key' ? info.apiKeySource : undefined,
    provider: billing === 'other' ? info.apiProvider : undefined,
  }
}
