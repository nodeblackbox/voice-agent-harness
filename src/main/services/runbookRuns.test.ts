import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunbookRun } from '@shared/types'
import { RunbookRunStore } from './runbookRuns'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const run = (i: number, status: RunbookRun['status']): RunbookRun => ({
  runId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, runbookId: 'x', title: 'X', status, step: null, scratch: {}, log: [], startedAt: i, updatedAt: i, activeMs: 0, steps: 0, consented: false
})

describe('RunbookRunStore', () => {
  it('saves runs and loads them newest first, dropping the oldest finished beyond fifty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-runs-'))
    dirs.push(dir)
    const store = new RunbookRunStore(join(dir, 'runs'))
    expect(store.load()).toEqual([])
    for (let i = 1; i <= 55; i++) store.save(run(i, 'done'))
    store.save(run(0, 'waiting'))
    const loaded = store.load()
    expect(loaded).toHaveLength(51)
    expect(loaded[0]!.startedAt).toBe(55)
    expect(loaded.some((r) => r.status === 'waiting')).toBe(true)
    expect(readdirSync(join(dir, 'runs'))).toHaveLength(51)
  })

  it('refuses a run id that could escape the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-runs-'))
    dirs.push(dir)
    const store = new RunbookRunStore(join(dir, 'runs'))
    store.save({ ...run(1, 'done'), runId: '../../evil' })
    expect(store.load()).toEqual([])
  })
})
