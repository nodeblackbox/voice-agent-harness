import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { editFile, type EditResult } from './edit'
import { PcExplorer } from './fs'

let tmp: string
let root: string
let outside: string
let backupDir: string
let ex: PcExplorer

const write = (rel: string, text: string | Buffer): string => {
  const p = path.join(tmp, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
  return p
}
const read = (p: string): string => fs.readFileSync(p, 'utf8')
const edit = (p: string, find: string, replace: string, all = false) => editFile(ex, { path: p, find, replace, all }, { backupDir })
const refusedWith = (r: EditResult, text: string): void => {
  expect(r).toMatchObject({ ok: false, refused: expect.stringContaining(text) })
}

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'va-edit-')))
  root = path.join(tmp, 'allowed')
  outside = path.join(tmp, 'private')
  backupDir = path.join(tmp, 'backups')
  fs.mkdirSync(root, { recursive: true })
  write('private/diary.txt', 'port = 4100')
  ex = new PcExplorer(() => [root])
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('editFile', () => {
  it('replaces one piece of text, keeps a copy of the file as it was, and says where', async () => {
    const p = write('allowed/config.ini', '[server]\nhost = localhost\nport = 4100\n')
    const r = await edit(p, 'port = 4100', 'port = 4200')
    expect(r).toMatchObject({ ok: true, path: p, replaced: 1, line: 3 })
    expect(read(p)).toBe('[server]\nhost = localhost\nport = 4200\n')
    const backup = (r as { backup: string }).backup
    expect(path.dirname(backup)).toBe(backupDir)
    expect(read(backup)).toBe('[server]\nhost = localhost\nport = 4100\n')
  })

  it('keeps Windows line endings, and matches text written with plain line breaks', async () => {
    const p = write('allowed/crlf.txt', 'one\r\ntwo\r\nthree\r\n')
    expect((await edit(p, 'one\ntwo', 'one\n2')).ok).toBe(true)
    expect(read(p)).toBe('one\r\n2\r\nthree\r\n')
  })

  it('refuses when it is not clear which text is meant, unless every occurrence is asked for', async () => {
    const p = write('allowed/twice.txt', 'debug = true\nother\ndebug = true\n')
    refusedWith(await edit(p, 'debug = true', 'debug = false'), 'occurs 2 times')
    expect(read(p)).toBe('debug = true\nother\ndebug = true\n')
    expect(await edit(p, 'debug = true', 'debug = false', true)).toMatchObject({ ok: true, replaced: 2 })
    expect(read(p)).toBe('debug = false\nother\ndebug = false\n')
    refusedWith(await edit(p, 'not there', 'x'), 'not in the file')
    refusedWith(await edit(p, 'other', 'other'), 'same as the old')
    refusedWith(await edit(p, '', 'x'), 'find is empty')
  })

  it('never deletes: not the file, not its contents', async () => {
    const p = write('allowed/small.txt', 'only line\n')
    refusedWith(await edit(p, 'only line\n', ''), 'leave the file empty')
    const big = write('allowed/big.txt', `${'keep this line\n'.repeat(10)}${'remove me\n'.repeat(60)}`)
    refusedWith(await edit(big, 'remove me\n', '', true), 'more than half')
    expect(read(p)).toBe('only line\n')
    expect(read(big)).toContain('remove me')
    refusedWith(await edit(path.join(root, 'new.txt'), 'a', 'b'), 'New files are not created')
    expect(fs.existsSync(path.join(root, 'new.txt'))).toBe(false)
  })

  it('stays inside the approved folders, however the path is written', async () => {
    const tries = [path.join(outside, 'diary.txt'), path.join(root, '..', 'private', 'diary.txt'), `${root}${path.sep}sub${path.sep}..${path.sep}..${path.sep}private${path.sep}diary.txt`]
    for (const t of tries) refusedWith(await edit(t, '4100', '4200'), 'outside the folders')
    refusedWith(await edit('diary.txt', '4100', '4200'), 'full path')
    refusedWith(await edit('..\\private\\diary.txt', '4100', '4200'), 'full path')
    refusedWith(await edit('\\\\server\\share\\x.txt', 'a', 'b'), 'not allowed')
    try {
      fs.symlinkSync(outside, path.join(root, 'escape'), 'junction')
      refusedWith(await edit(path.join(root, 'escape', 'diary.txt'), '4100', '4200'), 'outside the folders')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e
    }
    expect(read(path.join(outside, 'diary.txt'))).toBe('port = 4100')
  })

  it('refuses a second name for a file (hard link), which could be a file outside', async () => {
    const link = path.join(root, 'hard.txt')
    try {
      fs.linkSync(path.join(outside, 'diary.txt'), link)
    } catch {
      return
    }
    refusedWith(await edit(link, '4100', '4200'), 'hard link')
    expect(read(path.join(outside, 'diary.txt'))).toBe('port = 4100')
    fs.unlinkSync(link)
  })

  it('refuses secrets files, git data, binaries, folders and oversized or non-UTF-8 files', async () => {
    refusedWith(await edit(write('allowed/.env', 'KEY=abc'), 'abc', 'xyz'), 'never opened or changed')
    refusedWith(await edit(write('allowed/repo/.git/config', '[core]\n'), '[core]', '[core]\nfsmonitor = evil'), "Git's own files")
    refusedWith(await edit(write('allowed/pic.png', Buffer.from([1, 2, 0, 3])), 'a', 'b'), 'not a text file')
    refusedWith(await edit(write('allowed/latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])), 'caf', 'tea'), 'not plain UTF-8')
    refusedWith(await edit(write('allowed/huge.txt', 'x'.repeat(1024 * 1024 + 10)), 'x', 'y'), 'larger than one megabyte')
    refusedWith(await edit(path.join(root, 'repo'), 'a', 'b'), 'folder')
    refusedWith(await edit(root, 'a', 'b'), 'not a file')
    expect(read(path.join(root, '.env'))).toBe('KEY=abc')
  })

  it('does nothing without a backup folder', async () => {
    const p = write('allowed/nobackup.txt', 'a = 1\n')
    refusedWith(await editFile(ex, { path: p, find: 'a = 1', replace: 'a = 2' }, {}), 'switched off')
    expect(read(p)).toBe('a = 1\n')
  })
})
