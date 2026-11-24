/** The approved-folder list behind Settings > PC access: checking a folder the user adds, and the first-run list. */
import fs from 'node:fs'
import path from 'node:path'

export type RootCheck = { ok: true; path: string } | { ok: false; error: string }

/** A folder typed or picked in Settings: tidied ("D:" becomes "D:\"), and it must exist and be given in full. */
export function checkRoot(input: string): RootCheck {
  let p = (input ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
  if (!p) return { ok: false, error: 'Type a folder, for example D:\\ or C:\\Users\\you\\Projects.' }
  if (/^[\\/]{2}/.test(p)) return { ok: false, error: 'Network and device paths cannot be approved.' }
  if (/^[a-z]:$/i.test(p)) p += path.sep
  if (!path.isAbsolute(p)) return { ok: false, error: 'Give the full path, starting with the drive (for example D:\\Projects).' }
  p = path.resolve(p)
  if (/^[a-z]:/.test(p)) p = p[0]!.toUpperCase() + p.slice(1)
  try {
    if (!fs.statSync(p).isDirectory()) return { ok: false, error: 'That is a file. Approve the folder it is in.' }
  } catch {
    return { ok: false, error: `There is no folder at ${p}.` }
  }
  return { ok: true, path: p }
}

/** `child` is `parent` or inside it (by path text; Windows ignores case). */
export function within(parent: string, child: string): boolean {
  const [a, b] = process.platform === 'win32' ? [parent.toLowerCase(), child.toLowerCase()] : [parent, child]
  const rel = path.relative(a, b)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Add a folder to the list: no duplicates, and a folder already covered by a wider one is not listed twice. */
export function addRoot(roots: string[], added: string): string[] {
  if (roots.some((r) => within(r, added))) return roots
  return [...roots.filter((r) => !within(added, r)), added]
}

/** The first-run list: the candidates that exist, in order, without duplicates or folders inside one another. */
export function firstRunRoots(candidates: Array<string | null | undefined>): string[] {
  let out: string[] = []
  for (const c of candidates) {
    if (!c) continue
    const r = checkRoot(c)
    if (r.ok) out = addRoot(out, r.path)
  }
  return out
}
