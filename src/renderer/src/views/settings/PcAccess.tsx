import { useState } from 'react'
import { Folder, FolderOpen, FolderSearch, Plus, X } from 'lucide-react'
import type { ExploreSettings } from '@shared/types'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Btn, Card, IconBtn, Row, TextInput, Toggle } from '../../components/primitives'

const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/**
 * Which folders the assistant's read-only pc_* tools may look in. The list is the fence: nothing outside it can
 * be listed, searched or read, and nothing anywhere can be changed.
 */
export function PcAccess() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  if (!settings) return null
  const x: ExploreSettings = settings.explore ?? { enabled: false, roots: [], agent: true }
  const name = settings.agentName || 'The assistant'
  const set = (patch: Partial<ExploreSettings>) => void updateSettings({ explore: { ...x, ...patch } })

  const add = async (raw: string): Promise<void> => {
    const r = await window.api.explore.check(raw)
    if (!r.ok) return setError(r.error)
    if (x.roots.some((p) => same(p, r.path))) return setError(`${r.path} is already on the list.`)
    setError('')
    setTyped('')
    set({ roots: [...x.roots, r.path] })
  }
  const browse = async (): Promise<void> => {
    const picked = await window.api.explore.pickFolder()
    if (picked) await add(picked)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <FolderSearch size={14} style={{ color: T.text2 }} />
        <span className="text-sm font-medium">PC access</span>
      </div>
      <Card pad={0}>
        <div className="px-4">
          <Row
            label={`Let ${name} look at your files`}
            sub="Read-only: list a folder, find files and folders by name, read text files and search inside them. Nothing can be changed, moved, deleted or run, and only the folders below can be seen."
          >
            <Toggle on={x.enabled} onChange={(v) => set({ enabled: v })} />
          </Row>
          <Row
            label="Explorer helper"
            sub="For questions that take several steps (“find my lemon AI project on the D drive”), a helper chains the searches itself and comes back with one short answer. Off: the assistant makes each call itself, which uses more of its tool rounds per reply."
          >
            <Toggle on={x.agent} onChange={(v) => set({ agent: v })} />
          </Row>
          <div className="py-3 flex flex-col gap-2" style={{ opacity: x.enabled ? 1 : 0.55 }}>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm">Approved folders</span>
              <span className="text-xs" style={{ color: T.text3, lineHeight: 1.4 }}>
                Everything inside an approved folder can be read, sub-folders included. Add a whole drive (D:\) or just your project folders.
              </span>
            </div>
            {x.roots.length === 0 ? (
              <div className="text-xs rounded-lg px-3 py-2" style={{ color: T.amber, background: T.amberTint }}>
                No folders approved, so {name} cannot see any files yet.
              </div>
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Approved folders">
                {x.roots.map((p) => (
                  <li key={p} className="flex items-center gap-2 rounded-lg pl-3 pr-1" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                    <Folder size={13} style={{ color: T.text3, flexShrink: 0 }} />
                    <span className="text-xs truncate flex-1 py-1.5" style={{ fontFamily: T.mono, color: T.text2 }} title={p}>
                      {p}
                    </span>
                    <IconBtn icon={X} label={`Remove ${p}`} size={13} w={26} onClick={() => set({ roots: x.roots.filter((r) => r !== p) })} />
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2">
              <TextInput
                value={typed}
                onChange={(v) => {
                  setTyped(v)
                  if (error) setError('')
                }}
                mono
                placeholder="D:\ or a full folder path"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typed.trim()) void add(typed)
                }}
              />
              <Btn small primary icon={Plus} disabled={!typed.trim()} onClick={() => void add(typed)}>
                Add
              </Btn>
              <Btn small icon={FolderOpen} onClick={() => void browse()}>
                Browse…
              </Btn>
            </div>
            {error && (
              <span className="text-xs" role="alert" style={{ color: T.amber }}>
                {error}
              </span>
            )}
            <span className="text-xs" style={{ color: T.text3, lineHeight: 1.4 }}>
              Files that usually hold passwords or keys (.env, private keys, credential stores) are never opened, even inside an approved folder, and anything that looks like a key is masked before the assistant sees it.
            </span>
          </div>
        </div>
      </Card>
    </div>
  )
}
