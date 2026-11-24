import { describe, expect, it } from 'vitest'
import { draftKey, unsavedIn, useDrafts } from '../../state/drafts'
import { languageFor, languageLabel } from './languages'

describe('editor languages', () => {
  it('picks the syntax from the file name', () => {
    expect(languageLabel('src/App.tsx')).toBe('TypeScript React')
    expect(languageLabel('src/core/agent.ts')).toBe('TypeScript')
    expect(languageLabel('tools/report.py')).toBe('Python')
    expect(languageLabel('package.json')).toBe('JSON')
    expect(languageLabel('docs/README.MD')).toBe('Markdown')
    expect(languageLabel('config.yaml')).toBe('YAML')
    expect(languageLabel('C:\\work\\Dockerfile')).toBe('Dockerfile')
    expect(languageLabel('.env.local')).toBe('Config')
    expect(languageLabel('run.ps1')).toBe('PowerShell')
  })
  it('falls back to plain text for names it does not know', () => {
    expect(languageFor('notes.txt')).toBeNull()
    expect(languageFor('LICENSE')).toBeNull()
    expect(languageLabel('data.xyz')).toBe('Plain text')
  })
  it('loads a grammar on demand', async () => {
    expect(await languageFor('a.json')!.load()).toBeTruthy()
    expect(await languageFor('a.toml')!.load()).toBeTruthy()
  })
})

describe('unsaved drafts', () => {
  it('keeps edits per session and file, and forgets them when dropped', () => {
    const { put, drop } = useDrafts.getState()
    put(draftKey('s1', 'src/a.ts'), { text: 'x', baseMtime: 1 })
    put(draftKey('s1', 'b.md'), { text: 'y', baseMtime: 2 })
    put(draftKey('s2', 'src/a.ts'), { text: 'z', baseMtime: 3 })
    expect([...unsavedIn(useDrafts.getState().drafts, 's1')].sort()).toEqual(['b.md', 'src/a.ts'])
    drop(draftKey('s1', 'b.md'))
    expect([...unsavedIn(useDrafts.getState().drafts, 's1')]).toEqual(['src/a.ts'])
    expect([...unsavedIn(useDrafts.getState().drafts, 's2')]).toEqual(['src/a.ts'])
  })
})
