import { KeyRound } from 'lucide-react'
import { T } from '../../theme'
import { selectHasAnyKey, useStore } from '../../state/store'
import { Btn } from '../primitives'

/** Above the transcript until at least one provider has an API key: the one thing a fresh install needs. */
export function NoKeyBanner() {
  const hasAnyKey = useStore(selectHasAnyKey)
  const setView = useStore((s) => s.setView)
  if (hasAnyKey !== false) return null
  return (
    <div role="status" className="mx-4 mt-3 rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: T.amberTint, border: `1px solid ${T.amber}`, color: T.text }}>
      <KeyRound size={16} style={{ color: T.amber, flexShrink: 0 }} />
      <div className="flex-1 min-w-0">
        <div className="text-sm" style={{ fontWeight: 600 }}>
          No API key yet
        </div>
        <div className="text-xs" style={{ color: T.text2 }}>
          Add a key for any one provider (Anthropic, OpenAI, Groq, Google or xAI) and the agent can answer. The voice and the ears work without one.
        </div>
      </div>
      <Btn small primary icon={KeyRound} onClick={() => setView('settings')}>
        Open Settings
      </Btn>
    </div>
  )
}
