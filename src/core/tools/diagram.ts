import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { MAX_DIAGRAM_CHARS, applyEdits, cleanCode, diagramKind, diffLabel, latest, type DiagramCheck, type DiagramDoc } from '@shared/diagram'
import type { DiagramLibrary } from '../diagrams/library'

export interface DiagramDeps {
  library: DiagramLibrary
  /**
   * Runs Mermaid's own parser on the code (it lives in the app window). Null when it could not be asked,
   * e.g. the window is closed: the diagram is then kept unchecked.
   */
  check(code: string): Promise<DiagramCheck | null>
}

/** The mistakes that break Mermaid most often; the model reads these with every drawing call. */
export const MERMAID_RULES = `Mermaid rules (version 11): start with the header line (flowchart TD, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, mindmap, timeline, gantt, journey, pie, quadrantChart). No code fences and no %%{init}%% block. Node ids are short and plain (letters, digits, underscores); never "end", "graph", "subgraph", "class" or "style" as an id. Put any label containing punctuation such as ( ) [ ] { } : ; , # & | or quotes in double quotes: A["Check (fast) path"]; write a double quote inside a label as #quot;. Edge labels: A -->|yes| B. No HTML except <br/>. Mindmap and timeline are indentation-based, one item per line, no arrows. Keep it readable: under 40 nodes unless asked for more.`

const where = (deps: DiagramDeps, sessionId: () => string, ref: string | undefined): DiagramDoc | undefined => deps.library.find(ref, sessionId())

const others = (deps: DiagramDeps, except?: string): Array<{ id: string; title: string }> =>
  deps.library
    .list()
    .filter((d) => d.id !== except)
    .slice(0, 8)
    .map((d) => ({ id: d.id, title: d.title }))

export function diagramTools(deps: DiagramDeps, sessionId: () => string): ToolSet {
  /** Parse errors go back to the model as the tool result, so it corrects the code and calls again. */
  const refuse = async (code: string): Promise<string | null> => {
    if (!code) return 'The diagram code is empty.'
    if (code.length > MAX_DIAGRAM_CHARS) return `The diagram is too long (${code.length} characters; the limit is ${MAX_DIAGRAM_CHARS}).`
    const r = await deps.check(code)
    return r && !r.ok ? r.error : null
  }

  return {
    diagram_create: tool({
      description: `Draw a NEW diagram and show it in the chat right away, rendered, where the user can also open its code and edit it. Use it whenever a picture explains something better than talking: a process, a decision, a sequence of calls, states, a data model, a timeline, a mind map. ${MERMAID_RULES} If the result is an error, the code did not compile: fix what the error names and call this again.`,
      inputSchema: z.object({
        title: z.string().describe('3-6 words naming the diagram, e.g. "Making a cup of tea"'),
        code: z.string().describe('The complete Mermaid source')
      }),
      execute: async ({ title, code }) => {
        const clean = cleanCode(code)
        const error = await refuse(clean)
        if (error) return { error: `Mermaid could not read this, so nothing was shown: ${error}` }
        const doc = deps.library.create({ title, code: clean, sessionId: sessionId(), by: 'agent' })
        return { status: 'shown', id: doc.id, title: doc.title, version: 1, kind: diagramKind(clean) }
      }
    }),
    diagram_edit: tool({
      description:
        'Change a diagram that already exists; the user sees what changed as a red and green diff and can step back to any earlier version. Prefer "edits": small find-and-replace steps. Each "find" is text copied exactly from the current code (same spaces and line breaks) that appears exactly once, usually one or more whole lines; to add lines, find a nearby line and replace it with that line plus the new ones; to delete, replace with "". Change only what was asked and keep ids and styling. Give "code" (the whole new source) only for a rewrite. Without "diagram" it changes the one last worked on in this chat. The user may have edited it by hand: if an edit does not apply, the result carries the current code, so copy from that and try again.',
      inputSchema: z.object({
        diagram: z.string().optional().describe('Its id or (part of) its title; omit for the most recent one'),
        edits: z.array(z.object({ find: z.string(), replace: z.string() })).optional(),
        code: z.string().optional().describe('The complete new source, for a rewrite'),
        title: z.string().optional().describe('A new title, when it should be renamed'),
        note: z.string().optional().describe('One short sentence on what changed')
      }),
      execute: async ({ diagram, edits, code, title, note }) => {
        const doc = where(deps, sessionId, diagram)
        if (!doc) return { error: diagram ? `No diagram matches "${diagram}".` : 'There is no diagram yet; draw one with diagram_create.', diagrams: others(deps) }
        const current = latest(doc).code
        let next = current
        if (code !== undefined) next = cleanCode(code)
        else if (edits?.length) {
          const r = applyEdits(current, edits)
          if (!r.ok) return { error: r.error, id: doc.id, current_code: current }
          next = r.code
        } else if (!title) return { error: 'Say what to change: edits, code or title.' }
        if (next !== current) {
          const error = await refuse(next)
          if (error) return { error: `Mermaid could not read the changed diagram, so it was left as it was: ${error}`, id: doc.id, current_code: current }
        }
        const r = deps.library.commit(doc.id, { code: next, by: 'agent', note, title })!
        if (!r.changed) return { status: 'no_change', id: doc.id, version: latest(doc).n, title: doc.title }
        return { status: 'updated', id: r.doc.id, title: r.doc.title, version: latest(r.doc).n, changed: diffLabel(current, next) || 'renamed' }
      }
    }),
    diagram_get: tool({
      description:
        'Read a diagram: its current Mermaid code (including any edits the user made by hand), to answer questions about it, use it as the reference for something else, or before changing one you have not seen. Without "diagram" it returns the one last worked on in this chat, plus the titles of the others.',
      inputSchema: z.object({ diagram: z.string().optional().describe('Its id or (part of) its title; omit for the most recent one') }),
      execute: async ({ diagram }) => {
        const doc = where(deps, sessionId, diagram)
        if (!doc) return { error: diagram ? `No diagram matches "${diagram}".` : 'There are no diagrams yet.', diagrams: others(deps) }
        const v = latest(doc)
        return { id: doc.id, title: doc.title, kind: diagramKind(v.code), version: v.n, last_edited_by: v.by === 'user' ? 'the user' : 'you', code: v.code, other_diagrams: others(deps, doc.id) }
      }
    })
  }
}

/** One line per diagram in this chat for the live part of the prompt, so "the tea diagram" means something. */
export function diagramContextBlock(library: DiagramLibrary, sessionId: string): string {
  const mine = library.list().filter((d) => d.sessionId === sessionId).slice(0, 6)
  if (!mine.length) return ''
  return mine.map((d) => `- "${d.title}" (${d.kind}, id ${d.id}, version ${d.versions}${d.editedByUser ? ', edited by hand since your last change: read it with diagram_get before editing' : ''})`).join('\n')
}
