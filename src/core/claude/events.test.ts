import { describe, expect, it } from 'vitest'
import { cleanPrompt, historyEvents, messageEvents } from './events'

describe('cleanPrompt', () => {
  it('drops CLI wrappers and keeps what the user typed', () => {
    expect(cleanPrompt('<system-reminder>be nice</system-reminder>\nFix the build')).toBe('Fix the build')
    expect(cleanPrompt('<command-name>/model</command-name><command-args>opus</command-args>')).toBe('/model opus')
    expect(cleanPrompt('<local-command-stdout>Set model</local-command-stdout>')).toBe('')
  })
})

describe('transcript events', () => {
  const transcript = [
    { type: 'user', message: { content: '<system-reminder>x</system-reminder>Make a site' }, parent_tool_use_id: null },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'On it.' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'a.html', content: 'x'.repeat(9000) } }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'sub-agent chatter' }] }, parent_tool_use_id: 'agent1' },
    { type: 'user', message: { content: [{ type: 'text', text: 'Now make it blue' }] }, parent_tool_use_id: null }
  ]

  it('turns a saved transcript into prompts, replies, tool calls and results (no thinking, no sub-agent internals)', () => {
    const ev = historyEvents(transcript)
    expect(ev.map((e) => e.kind)).toEqual(['user', 'text', 'tool', 'tool_result', 'user'])
    expect(ev[0]!.text).toBe('Make a site')
    expect(ev[2]).toMatchObject({ tool: 'Write', toolId: 't1', text: 'Write a.html' })
    expect(String(ev[2]!.input!.content).length).toBeLessThan(8100)
    expect(ev[4]!.text).toBe('Now make it blue')
  })

  it('live runs skip echoed user text', () => {
    expect(messageEvents(transcript[0], 1)).toEqual([])
    expect(messageEvents(transcript[2], 1)).toEqual([{ t: 1, kind: 'tool_result', text: 'ok', toolId: 't1' }])
  })
})
