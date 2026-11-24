/**
 * Unsaved edits from the file viewer, kept while the app is open so switching to another file (or another
 * view) and back does not lose them. A draft exists only while its text differs from the file on disk.
 */
import { create } from 'zustand'

export interface Draft {
  /** The edited text, with \n line ends (the file's own line ends are restored on save). */
  text: string
  /** The file's change time when the edit began: a save refuses if the file has changed since. */
  baseMtime: number
}

interface DraftStore {
  drafts: Record<string, Draft>
  put(key: string, d: Draft): void
  drop(key: string): void
}

export const draftKey = (sessionId: string, rel: string): string => `${sessionId}\n${rel}`

export const useDrafts = create<DraftStore>((set) => ({
  drafts: {},
  put: (key, d) => set((s) => ({ drafts: { ...s.drafts, [key]: d } })),
  drop: (key) =>
    set((s) => {
      if (!(key in s.drafts)) return s
      const { [key]: _gone, ...rest } = s.drafts
      return { drafts: rest }
    })
}))

/** Paths with unsaved edits in one session. */
export function unsavedIn(drafts: Record<string, Draft>, sessionId: string): Set<string> {
  const prefix = `${sessionId}\n`
  return new Set(Object.keys(drafts).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)))
}
