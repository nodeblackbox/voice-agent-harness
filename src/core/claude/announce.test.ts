import { describe, expect, it } from 'vitest'
import { announcement } from './announce'

describe('announcement', () => {
  it('reads a question with numbered options', () => {
    const line = announcement({
      type: 'needs-input', id: '1', name: 'Landing page',
      pending: { id: 'p', kind: 'question', toolName: 'AskUserQuestion', summary: '', questions: [{ question: 'Which framework?', header: 'fw', multiSelect: false, options: [{ label: 'React' }, { label: 'Svelte' }] }] },
    })
    expect(line).toBe('Landing page has a question. Which framework? 1, React. 2, Svelte.')
  })
  it('mentions extra questions', () => {
    const q = { question: 'A?', header: 'a', multiSelect: false, options: [{ label: 'x' }, { label: 'y' }] }
    expect(announcement({ type: 'needs-input', id: '1', name: 'S', pending: { id: 'p', kind: 'question', toolName: 'AskUserQuestion', summary: '', questions: [q, q, q] } })).toContain('2 more questions')
  })
  it('asks for approval in plain words', () => {
    expect(announcement({ type: 'needs-input', id: '1', name: 'API', pending: { id: 'p', kind: 'permission', toolName: 'PowerShell', summary: 'Run: npm test' } })).toBe('API wants to run: npm test. Is that okay?')
  })
  it('announces completion with a clipped summary, and stays quiet for other events', () => {
    expect(announcement({ type: 'finished', id: '1', name: 'API', summary: 'All tests pass.' })).toBe('API is done. All tests pass.')
    expect(announcement({ type: 'finished', id: '1', name: 'API', summary: 'x'.repeat(500) })!.length).toBeLessThan(260)
    expect(announcement({ type: 'event', id: '1', event: { t: 0, kind: 'text', text: 'hi' } })).toBeNull()
  })
})
