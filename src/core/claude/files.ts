/**
 * Read-only access to a session's workspace for the UI and the voice tools: a capped listing and
 * a size-capped file read. Every path goes through the same fence as the sessions themselves, so a
 * crafted `../` or a junction can never reach outside the workspace.
 */
import fs from 'node:fs'
import path from 'node:path'
import { insideRoot } from './fence'
import type { CcFile, CcFileContent } from './types'

/** Folders shown but never walked: big, generated, or not interesting to look at. */
export const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', 'dist', 'build', '.cache', '.turbo'])

/** Absolute path of `rel` inside `root`, or null when it would leave the workspace. */
export function resolveInside(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel) || /^[\\/]/.test(rel)) return null
  const abs = path.resolve(root, rel)
  return insideRoot(abs, { root }) ? abs : null
}

/** Breadth-first listing, folders before files, at most `max` entries. Missing root => empty list. */
export function listWorkspace(root: string, max = 1500): CcFile[] {
  const out: CcFile[] = []
  const queue: string[] = ['']
  while (queue.length) {
    const rel = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    for (const e of entries) {
      if (e.isSymbolicLink()) continue // never follow links out of the workspace
      const p = rel ? `${rel}/${e.name}` : e.name
      let st: fs.Stats
      try {
        st = fs.statSync(path.join(root, p))
      } catch {
        continue
      }
      if (out.length >= max) return out
      const dir = e.isDirectory()
      const skipped = dir && SKIP_DIRS.has(e.name)
      out.push({ path: p, dir, size: dir ? 0 : st.size, mtime: st.mtimeMs, ...(skipped ? { skipped } : {}) })
      if (dir && !skipped) queue.push(p)
    }
  }
  return out
}

/** Text files up to `maxBytes` (longer ones are cut); anything with NUL bytes is reported as binary. */
export function readWorkspaceFile(root: string, rel: string, maxBytes = 400_000): CcFileContent | { error: string } {
  const abs = resolveInside(root, rel)
  if (!abs) return { error: 'That path is outside the workspace.' }
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return { error: 'No such file.' }
  }
  if (!st.isFile()) return { error: 'Not a file.' }
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(Math.min(st.size, maxBytes))
    fs.readSync(fd, buf, 0, buf.length, 0)
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', size: st.size }
    return { kind: 'text', text: buf.toString('utf8'), size: st.size, truncated: st.size > maxBytes }
  } finally {
    fs.closeSync(fd)
  }
}
