import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listWorkspace, readWorkspaceFile, resolveInside } from './files'

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
    expect(readWorkspaceFile(root, 'src/app.js')).toEqual({ kind: 'text', text: 'console.log(1)\n', size: 15, truncated: false })
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
})
