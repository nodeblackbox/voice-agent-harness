import { describe, expect, it } from 'vitest'
import { applyEdits, cleanCode, diagramKind, diffLabel, diffStat, lineDiff, splitFences } from './diagram'

const TEA = 'flowchart TD\n  A[Start] --> B[Boil the kettle]\n  B --> C[Pour]\n  C --> D[Drink]'

describe('diagram code', () => {
  it('drops a code fence and Windows line ends', () => {
    expect(cleanCode('```mermaid\r\nflowchart TD\r\n  A --> B\r\n```')).toBe('flowchart TD\n  A --> B')
    expect(cleanCode('  pie\n "a": 1\n\n')).toBe('pie\n "a": 1')
  })
  it('names the kind from the header line, skipping comments', () => {
    expect(diagramKind(TEA)).toBe('Flowchart')
    expect(diagramKind('%% note\nsequenceDiagram\n  A->>B: hi')).toBe('Sequence')
    expect(diagramKind('stateDiagram-v2\n [*] --> A')).toBe('State')
    expect(diagramKind('something else')).toBe('Diagram')
  })
})

describe('find-and-replace edits', () => {
  it('applies edits in order', () => {
    const r = applyEdits(TEA, [
      { find: 'B[Boil the kettle]', replace: 'B[Boil filtered water]' },
      { find: '  C --> D[Drink]', replace: '  C --> M{Milk?}\n  M --> D[Drink]' }
    ])
    expect(r).toEqual({ ok: true, code: 'flowchart TD\n  A[Start] --> B[Boil filtered water]\n  B --> C[Pour]\n  C --> M{Milk?}\n  M --> D[Drink]' })
  })
  it('refuses text that is missing or appears twice, and says which edit', () => {
    expect(applyEdits(TEA, [{ find: 'Kettle', replace: 'x' }])).toMatchObject({ ok: false, error: expect.stringContaining('not in the diagram') })
    const twice = applyEdits(TEA, [{ find: 'A[Start]', replace: 'A[Go]' }, { find: '-->', replace: '==>' }])
    expect(twice).toMatchObject({ ok: false, error: expect.stringMatching(/^Edit 2 .*more than once/) })
    expect(applyEdits(TEA, [{ find: '', replace: 'x' }]).ok).toBe(false)
  })
  it('deletes with an empty replacement', () => {
    expect(applyEdits(TEA, [{ find: '\n  C --> D[Drink]', replace: '' }])).toEqual({ ok: true, code: 'flowchart TD\n  A[Start] --> B[Boil the kettle]\n  B --> C[Pour]' })
  })
})

describe('line diff', () => {
  it('marks removed and added lines with their line numbers', () => {
    const after = TEA.replace('B[Boil the kettle]', 'B[Boil filtered water]') + '\n  D --> E[Wash up]'
    const d = lineDiff(TEA, after)
    expect(d.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'removed', text: '  A[Start] --> B[Boil the kettle]', a: 2 },
      { kind: 'added', text: '  A[Start] --> B[Boil filtered water]', b: 2 },
      { kind: 'added', text: '  D --> E[Wash up]', b: 5 }
    ])
    expect(diffStat(d)).toEqual({ added: 2, removed: 1 })
    expect(diffLabel(TEA, after)).toBe('+2 −1')
    expect(diffLabel(TEA, TEA)).toBe('')
  })
})

describe('Mermaid written into a reply', () => {
  const reply = `Here you go.\n\n\`\`\`mermaid\n${TEA}\n\`\`\`\n\nWant changes?`
  it('lifts the block out of the text', () => {
    expect(splitFences(reply)).toEqual({ text: 'Here you go.\n\nWant changes?', diagrams: [TEA] })
  })
  it('leaves ordinary text and other code alone', () => {
    expect(splitFences('hello')).toEqual({ text: 'hello', diagrams: [] })
    const other = 'x\n```js\n1\n```'
    expect(splitFences(other)).toEqual({ text: other, diagrams: [] })
  })
  it('hides a block that is still streaming until it closes', () => {
    const half = 'Here you go.\n\n```mermaid\nflowchart TD\n  A --> B'
    expect(splitFences(half, true)).toEqual({ text: 'Here you go.', diagrams: [] })
    // a reply that was cut off mid-block still shows what there is
    expect(splitFences(half, false).diagrams).toEqual(['flowchart TD\n  A --> B'])
  })
})
