import { describe, expect, it } from 'vitest'
import type { DiagramCheck, DiagramDoc } from '@shared/diagram'
import { DiagramLibrary, MAX_VERSIONS } from '../diagrams/library'
import { diagramContextBlock, diagramTools } from './diagram'

const TEA = 'flowchart TD\n  A[Start] --> B[Boil the kettle]\n  B --> C[Drink]'

function setup(check: (code: string) => DiagramCheck | null = () => ({ ok: true })) {
  const disk = new Map<string, DiagramDoc>()
  const changes: Array<string | null> = []
  let clock = 1000
  const library = new DiagramLibrary(
    { all: () => [...disk.values()], write: (d) => void disk.set(d.id, structuredClone(d)), remove: (id) => void disk.delete(id) },
    (doc) => changes.push(doc ? doc.title : null),
    () => (clock += 10)
  )
  const tools = diagramTools({ library, check: async (c) => check(c) }, () => 'chat-1')
  const call = (name: string, input: unknown): Promise<Record<string, unknown>> => (tools[name]!.execute as (i: unknown, o: unknown) => Promise<Record<string, unknown>>)(input, { toolCallId: 't', messages: [] })
  return { library, disk, changes, call }
}

describe('diagram tools', () => {
  it('draws a diagram, stores it and reports the version', async () => {
    const { call, library, disk, changes } = setup()
    const r = await call('diagram_create', { title: 'Making tea', code: '```mermaid\n' + TEA + '\n```' })
    expect(r).toMatchObject({ status: 'shown', title: 'Making tea', version: 1, kind: 'Flowchart' })
    const doc = library.get(r.id as string)!
    expect(doc.versions).toHaveLength(1)
    expect(doc.versions[0]).toMatchObject({ code: TEA, by: 'agent' })
    expect(doc.sessionId).toBe('chat-1')
    expect(disk.has(doc.id)).toBe(true)
    expect(changes).toEqual(['Making tea'])
  })

  it('shows nothing when Mermaid cannot read the code, and passes the error back', async () => {
    const { call, library } = setup(() => ({ ok: false, error: 'Parse error on line 2' }))
    const r = await call('diagram_create', { title: 'Broken', code: 'flowchart TD\n  A --> ' })
    expect(r.error).toContain('Parse error on line 2')
    expect(library.list()).toHaveLength(0)
  })

  it('keeps the diagram when the parser could not be asked', async () => {
    const { call, library } = setup(() => null)
    expect(await call('diagram_create', { title: 'Unchecked', code: TEA })).toMatchObject({ status: 'shown' })
    expect(library.list()).toHaveLength(1)
  })

  it('edits the most recent diagram with find-and-replace and adds a version', async () => {
    const { call, library } = setup()
    const { id } = await call('diagram_create', { title: 'Making tea', code: TEA })
    const r = await call('diagram_edit', { edits: [{ find: 'B[Boil the kettle]', replace: 'B[Boil filtered water]' }], note: 'Filtered water' })
    expect(r).toMatchObject({ status: 'updated', id, version: 2, changed: '+1 −1' })
    const doc = library.get(id as string)!
    expect(doc.versions.map((v) => v.n)).toEqual([1, 2])
    expect(doc.versions[1]).toMatchObject({ by: 'agent', note: 'Filtered water' })
    expect(doc.versions[0]!.code).toBe(TEA)
  })

  it('hands back the current code when an edit does not apply (the user may have changed it)', async () => {
    const { call, library } = setup()
    const { id } = await call('diagram_create', { title: 'Making tea', code: TEA })
    library.commit(id as string, { code: TEA.replace('Drink', 'Enjoy'), by: 'user' })
    const r = await call('diagram_edit', { diagram: 'tea', edits: [{ find: 'C[Drink]', replace: 'C[Sip]' }] })
    expect(r.error).toContain('not in the diagram')
    expect(r.current_code).toContain('C[Enjoy]')
    expect(library.get(id as string)!.versions).toHaveLength(2)
  })

  it('leaves the diagram as it was when the changed code does not compile', async () => {
    let n = 0
    const { call, library } = setup(() => (n++ === 0 ? { ok: true } : { ok: false, error: 'bad arrow' }))
    const { id } = await call('diagram_create', { title: 'Making tea', code: TEA })
    const r = await call('diagram_edit', { code: 'flowchart TD\n  A -->' })
    expect(r.error).toContain('bad arrow')
    expect(library.get(id as string)!.versions).toHaveLength(1)
  })

  it('renames without adding a version, and reports no change for the same code', async () => {
    const { call, library } = setup()
    const { id } = await call('diagram_create', { title: 'Making tea', code: TEA })
    expect(await call('diagram_edit', { title: 'Tea, properly' })).toMatchObject({ status: 'updated', changed: 'renamed', version: 1 })
    expect(library.get(id as string)!.title).toBe('Tea, properly')
    expect(await call('diagram_edit', { code: TEA })).toMatchObject({ status: 'no_change' })
    expect(await call('diagram_edit', {})).toMatchObject({ error: expect.stringContaining('Say what to change') })
  })

  it('reads a diagram by title, including the user\'s own edits', async () => {
    const { call, library } = setup()
    const a = await call('diagram_create', { title: 'Making tea', code: TEA })
    await call('diagram_create', { title: 'Login sequence', code: 'sequenceDiagram\n  A->>B: hi' })
    library.commit(a.id as string, { code: TEA + '\n  C --> D[Wash up]', by: 'user' })
    const r = await call('diagram_get', { diagram: 'the tea diagram' })
    expect(r).toMatchObject({ id: a.id, version: 2, last_edited_by: 'the user' })
    expect(r.code).toContain('Wash up')
    expect(r.other_diagrams).toEqual([expect.objectContaining({ title: 'Login sequence' })])
    expect(await call('diagram_get', { diagram: 'nope' })).toMatchObject({ error: 'No diagram matches "nope".' })
  })

  it('says there is nothing to edit before anything was drawn', async () => {
    const { call } = setup()
    expect(await call('diagram_edit', { edits: [{ find: 'a', replace: 'b' }] })).toMatchObject({ error: expect.stringContaining('no diagram yet') })
  })
})

describe('diagram library', () => {
  it('loads what is on disk and prefers this chat\'s latest diagram', () => {
    const { library, disk } = setup()
    const a = library.create({ title: 'A', code: TEA, sessionId: 'chat-1', by: 'agent' })
    const b = library.create({ title: 'B', code: TEA, sessionId: 'chat-2', by: 'agent' })
    expect(library.find(undefined, 'chat-1')!.id).toBe(a.id)
    expect(library.find(undefined, 'chat-9')!.id).toBe(b.id)
    const again = new DiagramLibrary({ all: () => [...disk.values()], write: () => {}, remove: () => {} })
    expect(again.list().map((d) => d.title)).toEqual(['B', 'A'])
  })
  it('caps the history but always keeps the first version', () => {
    const { library } = setup()
    const d = library.create({ title: 'A', code: 'pie\n "a": 0', by: 'agent' })
    for (let i = 1; i <= MAX_VERSIONS + 5; i++) library.commit(d.id, { code: `pie\n "a": ${i}`, by: 'user' })
    const v = library.get(d.id)!.versions
    expect(v).toHaveLength(MAX_VERSIONS)
    expect(v[0]!.n).toBe(1)
    expect(v.at(-1)!.n).toBe(MAX_VERSIONS + 6)
  })
  it('lists this chat\'s diagrams for the prompt and flags hand edits', () => {
    const { library } = setup()
    const a = library.create({ title: 'Making tea', code: TEA, sessionId: 'chat-1', by: 'agent' })
    library.create({ title: 'Elsewhere', code: TEA, sessionId: 'chat-2', by: 'agent' })
    expect(diagramContextBlock(library, 'chat-1')).toBe(`- "Making tea" (Flowchart, id ${a.id}, version 1)`)
    library.commit(a.id, { code: TEA + '\n  C --> D', by: 'user' })
    expect(diagramContextBlock(library, 'chat-1')).toContain('edited by hand')
    expect(diagramContextBlock(library, 'chat-3')).toBe('')
  })
  it('removes a diagram and tells listeners', () => {
    const { library, disk, changes } = setup()
    const a = library.create({ title: 'A', code: TEA, by: 'agent' })
    expect(library.remove(a.id)).toBe(true)
    expect(disk.size).toBe(0)
    expect(changes.at(-1)).toBeNull()
    expect(library.remove(a.id)).toBe(false)
  })
})
