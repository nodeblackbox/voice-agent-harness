/**
 * Diagrams shown in the chat: the documents (loaded on demand, kept fresh by `diagram` events) and the
 * owner's unsaved edits to them, which survive switching views.
 */
import { create } from 'zustand'
import type { DiagramDoc } from '@shared/diagram'

interface DiagramStore {
  /** null = looked for and gone (deleted). undefined = not loaded yet. */
  docs: Record<string, DiagramDoc | null>
  /** Unsaved code per diagram id. */
  drafts: Record<string, string>
  ensure(id: string): void
  apply(id: string, doc: DiagramDoc | null): void
  setDraft(id: string, code: string | null): void
}

const asked = new Set<string>()

export const useDiagrams = create<DiagramStore>((set, get) => ({
  docs: {},
  drafts: {},
  ensure: (id) => {
    if (id in get().docs || asked.has(id)) return
    asked.add(id)
    const api = window.api.diagrams
    if (!api) return set((s) => ({ docs: { ...s.docs, [id]: null } }))
    void api.get(id).then(
      (doc) => set((s) => (id in s.docs ? s : { docs: { ...s.docs, [id]: doc } })),
      () => asked.delete(id)
    )
  },
  apply: (id, doc) => set((s) => ({ docs: { ...s.docs, [id]: doc } })),
  setDraft: (id, code) =>
    set((s) => {
      if (code === null) {
        if (!(id in s.drafts)) return s
        const { [id]: _gone, ...rest } = s.drafts
        return { drafts: rest }
      }
      return { drafts: { ...s.drafts, [id]: code } }
    })
}))
