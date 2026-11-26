import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PlaybookLabels } from './playbookReview'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('PlaybookLabels', () => {
  it('keeps marks per playbook and message, clears them, and survives a new instance', () => {
    const dir = mkdtempSync(join(tmpdir(), 'va-labels-'))
    dirs.push(dir)
    const path = join(dir, 'playbook-labels.json')
    const a = new PlaybookLabels(path)
    expect(a.get('push')).toEqual({})
    a.set('push', 'm1', 'should_not')
    a.set('push', 'm2', 'should')
    a.set('idea', 'm1', 'should')
    a.set('push', 'm2', null)
    expect(new PlaybookLabels(path).get('push')).toEqual({ m1: 'should_not' })
    expect(new PlaybookLabels(path).get('idea')).toEqual({ m1: 'should' })
  })
})
