// Folder-touching manager behaviour (remove + delete folder, choosing a folder) against a real temp dir.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeSessionManager } from './manager'
import type { CcRun } from './types'

let base: string
let root: string
let project: string

const fakeSdk = (): CcRun => ({ messages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }, interrupt: async () => {}, close: () => {} })
const make = () => new ClaudeSessionManager({ sdk: fakeSdk, workspaceRoot: root, defaultMode: 'auto' })

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mgr-'))
  root = path.join(base, 'workspaces')
  project = path.join(base, 'code', 'my-app')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.writeFileSync(path.join(project, 'keep.txt'), 'precious')
})
afterEach(() => fs.rmSync(base, { recursive: true, force: true }))

describe('remove and delete folder', () => {
  it('removes a session and deletes its own sandbox folder only when asked', async () => {
    const m = make()
    const a = (m.start('slop one') as any).session
    const b = (m.start('slop two') as any).session
    fs.writeFileSync(path.join(a.workspace, 'index.html'), 'x')
    expect(await m.remove(b.id)).toEqual({ ok: true })
    expect(fs.existsSync(b.workspace)).toBe(true) // kept by default
    expect(await m.remove(a.id, { deleteFolder: true })).toEqual({ ok: true, deletedFolder: a.workspace })
    expect(fs.existsSync(a.workspace)).toBe(false)
    expect(fs.existsSync(root)).toBe(true)
    expect(m.list()).toEqual([])
  })

  it('never deletes a real project folder, the root, or a folder another session uses', async () => {
    const m = make()
    const ext = (m.start('my app', undefined, { folder: project }) as any).session
    expect(ext.external).toBe(true)
    expect(await m.remove(ext.id, { deleteFolder: true })).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(project, 'keep.txt'))).toBe(true)
    expect(m.get(ext.id)).toBeTruthy() // refused => nothing removed

    const one = (m.start('one', undefined, { folder: 'shared' }) as any).session
    const two = (m.start('two', undefined, { folder: 'shared' }) as any).session
    expect(one.workspace).toBe(two.workspace)
    expect(await m.remove(one.id, { deleteFolder: true })).toMatchObject({ ok: false, error: expect.stringContaining('Another session') })
    expect(await m.remove(two.id)).toEqual({ ok: true })
    expect(await m.remove(one.id, { deleteFolder: true })).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(root, 'shared'))).toBe(false)
  })
})

describe('choosing a folder', () => {
  it('reuses or creates a named folder under the root, and lists folders', () => {
    const m = make()
    fs.mkdirSync(path.join(root, 'bing-bong-jiggly'))
    const s = (m.start('again', undefined, { folder: 'Bing Bong Jiggly' }) as any).session
    expect(s.workspace).toBe(path.join(root, 'bing-bong-jiggly'))
    expect(s.external).toBeUndefined()
    expect(m.folders().map((f) => [f.name, f.inUse])).toEqual([['bing-bong-jiggly', true]])
  })

  it('a full path outside the root becomes a fenced external session; broad or missing folders are refused', () => {
    const m = make()
    expect(m.start('x', undefined, { folder: path.join(base, 'nope') })).toMatchObject({ ok: false })
    expect(m.start('x', undefined, { folder: path.parse(base).root })).toMatchObject({ ok: false })
    expect(m.start('x', undefined, { folder: root })).toMatchObject({ ok: false })
    const s = (m.start('app', undefined, { folder: project }) as any).session
    expect(s).toMatchObject({ workspace: project, external: true })
  })
})
