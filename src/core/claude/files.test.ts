import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listWorkspace, readWorkspaceFile, resolveInside, writeWorkspaceFile } from './files'

let base: string
let root: string

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-files-'))
  root = path.join(base, 'ws')
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>')
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(root, 'src', 'deep', 'x.txt'), 'x')
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), '')
  fs.writeFileSync(path.join(root, 'logo.bin'), Buffer.from([1, 0, 2, 3]))
  fs.writeFileSync(path.join(base, 'secret.txt'), 'outside')
})
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe('workspace files', () => {
  it('lists folders first, recursively, with forward-slash paths, and does not walk node_modules', () => {
    const list = listWorkspace(root)
    const paths = list.map((f) => f.path)
    expect(paths.slice(0, 2)).toEqual(['node_modules', 'src'])
    expect(paths).toContain('src/deep/x.txt')
    expect(paths).toContain('index.html')
    expect(paths).not.toContain('node_modules/pkg')
    expect(list.find((f) => f.path === 'node_modules')!.skipped).toBe(true)
    expect(list.find((f) => f.path === 'index.html')!.size).toBe(11)
  })

  it('caps the listing and copes with a missing root', () => {
    expect(listWorkspace(root, 3)).toHaveLength(3)
    expect(listWorkspace(path.join(base, 'nope'))).toEqual([])
  })

  it('reads text, flags binary, and cuts long files', () => {
    expect(readWorkspaceFile(root, 'src/app.js')).toMatchObject({ kind: 'text', text: 'console.log(1)\n', size: 15, truncated: false })
    expect(readWorkspaceFile(root, 'logo.bin')).toEqual({ kind: 'binary', size: 4 })
    expect(readWorkspaceFile(root, 'index.html', 4)).toMatchObject({ text: '<h1>', truncated: true })
  })

  it('refuses anything outside the workspace', () => {
    expect(resolveInside(root, '../secret.txt')).toBeNull()
    expect(resolveInside(root, path.join(base, 'secret.txt'))).toBeNull()
    expect(resolveInside(root, '/etc/passwd')).toBeNull()
    expect(resolveInside(root, 'src/../index.html')).toBe(path.join(root, 'index.html'))
    expect(readWorkspaceFile(root, '../secret.txt')).toEqual({ error: 'That path is outside the workspace.' })
    expect(readWorkspaceFile(root, 'src')).toEqual({ error: 'Not a file.' })
  })

  it('saves an edit to an existing file and reports its new change time', () => {
    const before = readWorkspaceFile(root, 'src/app.js')
    if (!('kind' in before) || before.kind !== 'text') throw new Error('expected text')
    const saved = writeWorkspaceFile(root, 'src/app.js', 'console.log(2)\n', before.mtime)
    expect(saved.ok).toBe(true)
    expect(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8')).toBe('console.log(2)\n')
    if (saved.ok) expect(saved.size).toBe(15)
  })

  it('refuses to save over a file that changed on disk since it was read, and writes nothing', () => {
    const p = path.join(root, 'src', 'deep', 'x.txt')
    const before = readWorkspaceFile(root, 'src/deep/x.txt')
    if (!('kind' in before) || before.kind !== 'text') throw new Error('expected text')
    fs.writeFileSync(p, 'claude wrote this')
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000)) // a later change time, whatever the clock resolution
    const saved = writeWorkspaceFile(root, 'src/deep/x.txt', 'mine', before.mtime)
    expect(saved).toMatchObject({ ok: false, conflict: true })
    expect(fs.readFileSync(p, 'utf8')).toBe('claude wrote this')
    // the user chose to overwrite: no expected time
    expect(writeWorkspaceFile(root, 'src/deep/x.txt', 'mine').ok).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('mine')
  })

  it('never writes outside the workspace, never creates a file, never writes a folder', () => {
    expect(writeWorkspaceFile(root, '../secret.txt', 'x')).toMatchObject({ ok: false })
    expect(fs.readFileSync(path.join(base, 'secret.txt'), 'utf8')).toBe('outside')
    expect(writeWorkspaceFile(root, 'new-file.txt', 'x')).toMatchObject({ ok: false, error: 'That file no longer exists.' })
    expect(fs.existsSync(path.join(root, 'new-file.txt'))).toBe(false)
    expect(writeWorkspaceFile(root, 'src', 'x')).toMatchObject({ ok: false, error: 'Not a file.' })
  })
})
