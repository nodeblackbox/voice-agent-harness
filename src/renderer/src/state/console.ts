import { create } from 'zustand'
import type { ConsoleEntry } from '@shared/console'
import { single } from '../lib/single'

/** Entries kept in the window; older ones scroll away (the files on disk keep everything). */
export const CONSOLE_KEEP = 5000

interface ConsoleStore {
  entries: ConsoleEntry[]
  /** Entries dropped off the top since the app opened. */
  trimmed: number
  /** Ids at or below this were cleared by the user. */
  clearedBefore: number
  add(batch: ConsoleEntry[]): void
  clear(): void
}

export const useConsole = create<ConsoleStore>((set, get) => ({
  entries: [],
  trimmed: 0,
  clearedBefore: 0,
  add(batch) {
    const cur = get().entries
    const last = cur.length ? cur[cur.length - 1]!.id : get().clearedBefore
    const fresh = batch.filter((e) => e.id > last)
    if (!fresh.length) return
    const all = cur.concat(fresh)
    const over = all.length - CONSOLE_KEEP
    set(over > 0 ? { entries: all.slice(over), trimmed: get().trimmed + over } : { entries: all })
  },
  clear() {
    const cur = get().entries
    set({ entries: [], clearedBefore: cur.length ? cur[cur.length - 1]!.id : get().clearedBefore })
  }
}))

/** Load this run's history and follow new entries. Safe to call again (hot reload): the old listener is replaced. */
export function startConsole(): void {
  const api = window.api?.console
  if (!api) return
  single('console-entries', () => api.onEntries((batch) => useConsole.getState().add(batch)))
  void api
    .history()
    .then((h) => {
      // history may overlap batches that already arrived: put it first, then whatever is newer
      const live = useConsole.getState().entries
      const firstLive = live.length ? live[0]!.id : Infinity
      const cleared = useConsole.getState().clearedBefore
      const older = h.filter((e) => e.id < firstLive && e.id > cleared)
      if (older.length) useConsole.setState({ entries: older.concat(live).slice(-CONSOLE_KEEP) })
    })
    .catch(() => undefined)
}
