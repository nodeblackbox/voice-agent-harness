import { describe, expect, it } from 'vitest'
import { changedFiles } from './gitStatus'

const fake = (err: Error | null, stdout: string) => ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(err, stdout)) as never

describe('changedFiles', () => {
  it('counts the lines git status prints, and is null outside a repository or without a folder', async () => {
    expect(await changedFiles('/repo', fake(null, ' M a.ts\n?? b.ts\n'))).toBe(2)
    expect(await changedFiles('/repo', fake(null, ''))).toBe(0)
    expect(await changedFiles('/tmp', fake(new Error('not a git repository'), ''))).toBeNull()
    expect(await changedFiles(undefined)).toBeNull()
  })
})
