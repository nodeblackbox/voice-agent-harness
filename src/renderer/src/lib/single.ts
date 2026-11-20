/**
 * One live subscription per key for the life of the window. A hot reload re-runs a module (resetting its
 * "already subscribed" flag) while the old listener stays registered with the preload; that doubled every
 * audio chunk into a second player, heard as an echo. Keeping the unsubscribe on `window` lets the new copy
 * remove the old listener before adding its own.
 */
type Registry = Map<string, () => void>

const registry = (): Registry => {
  const w = window as unknown as { __vaSubscriptions?: Registry }
  return (w.__vaSubscriptions ??= new Map())
}

export function single(key: string, subscribe: () => () => void): () => void {
  const reg = registry()
  reg.get(key)?.()
  const off = subscribe()
  const release = (): void => {
    if (reg.get(key) === release) reg.delete(key)
    off()
  }
  reg.set(key, release)
  return release
}
