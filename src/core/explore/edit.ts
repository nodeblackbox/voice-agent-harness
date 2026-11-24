/**
 * The one way the explorer module can change anything: replace a piece of text inside an existing text file.
 *
 * It cannot create, delete, rename or move a file, and it cannot empty one. The file must lie inside an approved
 * folder (the same fence as reading: `..`, symlinks and junctions resolved first), be ordinary UTF-8 text, and not be
 * one that holds secrets or belongs to git's own data. The text to replace must be found exactly once unless every
 * occurrence is asked for; anything less clear is refused. The file as it was is copied to the backup folder before
 * the change is written, so every edit can be undone by hand.
 */
import fs from 'node:fs'
import path from 'node:path'
import { isBinary, isSecretName, type PcExplorer } from './fs'

export interface EditInput {
  path: string
  /** The exact text to replace, as it stands in the file. */
  find: string
  replace: string
  /** Replace every occurrence; without it the text must occur exactly once. */
  all?: boolean
}

export type EditResult =
  | { ok: true; path: string; replaced: number; line: number; backup: string; bytes_before: number; bytes_after: number }
  | { ok: false; refused: string }
  | { ok: false; error: string }

const MAX_BYTES = 1024 * 1024

export async function editFile(ex: PcExplorer, input: EditInput, opts: { backupDir?: string; now?: () => number }): Promise<EditResult> {
  const no = (refused: string): EditResult => ({ ok: false, refused })
  if (!opts.backupDir) return no('Edits are switched off here (there is nowhere to keep the backup copy).')
  const raw = (input.path ?? '').trim().replace(/^["']+|["']+$/g, '')
  if (!/^([a-z]:[\\/]|[\\/])/i.test(raw)) return no('Give the full path of the file to edit, starting with the drive.')
  if (typeof input.find !== 'string' || !input.find) return no('Say exactly which text to replace (find is empty).')
  if (typeof input.replace !== 'string') return no('Say what to replace it with.')
  if (input.find === input.replace) return no('The new text is the same as the old.')

  const at = await ex.resolve(raw)
  if (!at.ok) return no(at.error)
  const file = at.path
  const name = path.basename(file)
  if (isSecretName(name)) return no(`${name} usually holds passwords or keys, so it is never opened or changed.`)
  const segments = file.toLowerCase().split(/[\\/]/)
  if (segments.includes('.git')) return no("Git's own files are never edited.")
  if (ex.roots().some((r) => r.toLowerCase() === file.toLowerCase())) return no('That is an approved folder, not a file.')

  let st: fs.Stats
  let data: Buffer
  try {
    st = await fs.promises.stat(file)
    if (!st.isFile()) return no(st.isDirectory() ? 'That is a folder, not a file.' : 'That is not an ordinary file.')
    // a second name for the same file may lie outside the approved folders; there is no telling, so refuse
    if (st.nlink > 1) return no('That file has more than one name on disk (a hard link), so it is not edited from here.')
    if (st.size > MAX_BYTES) return no('That file is larger than one megabyte, which is too big to edit from here.')
    data = await fs.promises.readFile(file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    return code === 'ENOENT' ? no(`There is no file at ${file}. New files are not created from here.`) : { ok: false, error: `Could not open ${file} (${code ?? 'unknown error'}).` }
  }
  if (isBinary(file, data)) return no('That is not a text file.')
  const text = data.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(data)) return no('That file is not plain UTF-8 text, so an edit could damage it.')

  // the model writes \n; a Windows file has \r\n. Match in the file's own line endings.
  const crlf = text.includes('\r\n')
  const eol = (s: string): string => (crlf ? s.replace(/\r?\n/g, '\r\n') : s)
  const find = eol(input.find)
  const replace = eol(input.replace)
  const count = text.split(find).length - 1
  if (count === 0) return no('That text is not in the file as written. Read the file and copy the exact text, spaces and line breaks included.')
  if (count > 1 && !input.all) return no(`That text occurs ${count} times, so it is not clear which one is meant. Include more of the surrounding text, or ask for every occurrence.`)
  const next = input.all ? text.split(find).join(replace) : text.replace(find, () => replace)
  if (!next.trim()) return no('That would leave the file empty, which counts as deleting it.')
  if (text.length > 400 && next.length < text.length / 2) return no('That would remove more than half of the file. Removing that much is not done from here.')

  const stamp = new Date(opts.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, '-')
  const backup = path.join(opts.backupDir, `${stamp}_${name}`)
  try {
    await fs.promises.mkdir(opts.backupDir, { recursive: true })
    await fs.promises.writeFile(backup, data, { flag: 'wx' })
    // the file must still be what was read: nothing else may have changed it in between
    const again = await fs.promises.stat(file)
    if (again.mtimeMs !== st.mtimeMs || again.size !== st.size) return no('The file changed while it was being edited. Nothing was written; read it again.')
    await fs.promises.writeFile(file, next, 'utf8')
  } catch (e) {
    return { ok: false, error: `The edit was not written (${(e as NodeJS.ErrnoException)?.code ?? (e as Error).message}).` }
  }
  return { ok: true, path: file, replaced: input.all ? count : 1, line: text.slice(0, text.indexOf(find)).split('\n').length, backup, bytes_before: data.length, bytes_after: Buffer.byteLength(next, 'utf8') }
}
