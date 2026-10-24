import { useEffect, useState } from 'react'
import { KeyRound, RefreshCw, ShieldCheck, UserRound } from 'lucide-react'
import type { CcAccount, CcSession } from '@shared/claude'
import { T } from '../../theme'

/** Who sessions run as, asked of Claude Code itself. Null while checking or when the running app predates it. */
export function useClaudeAccount(): { account: CcAccount | null; checking: boolean; recheck: () => void } {
  const [account, setAccount] = useState<CcAccount | null>(null)
  const [checking, setChecking] = useState(false)
  const supported = typeof window.api.claude?.account === 'function'
  const load = (fresh: boolean) => {
    if (!supported) return
    setChecking(true)
    window.api.claude.account(fresh)
      .then(setAccount, (e: unknown) => setAccount({ billing: 'unknown', error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setChecking(false))
  }
  useEffect(() => { load(false) }, [])
  return { account, checking, recheck: () => load(true) }
}

/** Sidebar line: which login Claude Code sessions bill. */
export function AccountBadge({ account, checking, recheck }: ReturnType<typeof useClaudeAccount>) {
  if (typeof window.api.claude?.account !== 'function') return null
  const look = !account
    ? { icon: UserRound, color: T.text3, border: T.border, bg: T.surface, title: 'Checking your Claude login…', sub: '' }
    : account.billing === 'subscription'
      ? {
          icon: ShieldCheck, color: T.green, border: 'rgba(74,222,128,.28)', bg: 'rgba(74,222,128,.06)',
          title: `${account.plan ?? 'Claude'} subscription`, sub: account.email ?? 'your claude login',
        }
      : account.billing === 'api-key'
        ? {
            icon: KeyRound, color: T.amber, border: T.amber, bg: T.amberTint,
            title: 'An API key would be billed', sub: `${account.keySource ?? 'API key'}: sessions are stopped before they run`,
          }
        : {
            icon: UserRound, color: T.amber, border: T.amber, bg: T.amberTint,
            title: account.billing === 'other' ? `Runs through ${account.provider ?? 'another provider'}` : "Couldn't check your Claude login",
            sub: account.error ? `${account.error} Run “claude” and /login in a terminal.` : '',
          }
  const Icon = look.icon
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2.5 py-2"
      style={{ background: look.bg, border: `1px solid ${look.border}` }}
      title={account?.billing === 'subscription'
        ? `Claude Code sessions run on your own login${account.organization ? ` (${account.organization})` : ''}: they use your plan's limits, not pay-per-token API credit. The voice agent's own API key is never passed to them.`
        : undefined}
    >
      <Icon size={14} style={{ color: look.color, flexShrink: 0 }} />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="text-xs font-medium truncate" style={{ color: account ? look.color : T.text2 }}>{look.title}</div>
        {/* a warning must be read in full; the email line can truncate */}
        {look.sub && <div className={`text-xs ${account?.billing === 'subscription' ? 'truncate' : ''}`} style={{ color: T.text3 }}>{look.sub}</div>}
      </div>
      <button
        type="button"
        aria-label="Check the login again"
        title="Check again"
        disabled={checking}
        onClick={recheck}
        className="inline-flex items-center justify-center rounded-md"
        style={{ width: 22, height: 22, color: T.text3, background: 'transparent', cursor: checking ? 'default' : 'pointer', flexShrink: 0 }}
      >
        <RefreshCw size={11} className={checking ? 'va-spin' : undefined} />
      </button>
    </div>
  )
}

/** Hover text for a cost figure: on a subscription it is usage priced at API rates, not a charge. */
export function costNote(s: Pick<CcSession, 'billing'> | null, plan?: string): string {
  if (s?.billing === 'api-key') return 'Charged to an API key'
  if (s?.billing === 'subscription' || plan) return `Usage at API prices. Covered by your ${plan ?? 'Claude'} plan, not charged per token.`
  return 'Usage at API prices'
}
