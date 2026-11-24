// Diagrams the agent draws (Mermaid). A diagram is a document with a version history: the agent and the
// owner both add versions, and any two versions can be compared line by line.

export interface DiagramVersion {
  /** 1-based, in order. */
  n: number
  code: string
  at: number
  by: 'agent' | 'user'
  /** One line on what changed, when the author gave one. */
  note?: string
}

export interface DiagramDoc {
  id: string
  title: string
  /** The chat it was drawn in. */
  sessionId?: string
  createdAt: number
  updatedAt: number
  versions: DiagramVersion[]
}

export interface DiagramSummary {
  id: string
  title: string
  kind: string
  versions: number
  updatedAt: number
  sessionId?: string
  /** The newest version was written by the owner, not the agent. */
  editedByUser: boolean
}

/** Result of running Mermaid's parser on a piece of code. */
export type DiagramCheck = { ok: true } | { ok: false; error: string }

export interface DiagramEdit {
  find: string
  replace: string
}

export const MAX_DIAGRAM_CHARS = 20_000

/** The source as Mermaid wants it: no code fence around it, Unix line ends, no trailing blank lines. */
export function cleanCode(code: string): string {
  let s = code.replace(/\r\n?/g, '\n').trim()
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s)
  if (fenced) s = fenced[1]!.trim()
  return s
}

const KINDS: Array<[RegExp, string]> = [
  [/^(flowchart|graph)\b/, 'Flowchart'],
  [/^sequenceDiagram\b/, 'Sequence'],
  [/^stateDiagram/, 'State'],
  [/^classDiagram/, 'Class'],
  [/^erDiagram\b/, 'ER'],
  [/^mindmap\b/, 'Mind map'],
  [/^timeline\b/, 'Timeline'],
  [/^gantt\b/, 'Gantt'],
  [/^journey\b/, 'Journey'],
  [/^pie\b/, 'Pie'],
  [/^quadrantChart\b/, 'Quadrant'],
  [/^gitGraph\b/, 'Git graph'],
  [/^(xychart-beta|sankey-beta|block-beta|architecture-beta|packet-beta|kanban|requirementDiagram|C4\w+)\b/, 'Diagram']
]

/** What kind of diagram this is, from its header line. */
export function diagramKind(code: string): string {
  const first = cleanCode(code)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%') && l !== '---')
  if (!first) return 'Diagram'
  for (const [re, label] of KINDS) if (re.test(first)) return label
  return 'Diagram'
}

export const latest = (doc: DiagramDoc): DiagramVersion => doc.versions[doc.versions.length - 1]!

export function summarize(doc: DiagramDoc): DiagramSummary {
  const v = latest(doc)
  return { id: doc.id, title: doc.title, kind: diagramKind(v.code), versions: doc.versions.length, updatedAt: doc.updatedAt, sessionId: doc.sessionId, editedByUser: v.by === 'user' }
}

/**
 * Find-and-replace edits, applied in order. Each `find` must appear exactly once in the code as it stands
 * when its turn comes, so an edit can never land somewhere the author did not mean.
 */
export function applyEdits(code: string, edits: DiagramEdit[]): { ok: true; code: string } | { ok: false; error: string } {
  let out = code.replace(/\r\n?/g, '\n')
  for (const [i, e] of edits.entries()) {
    const find = e.find.replace(/\r\n?/g, '\n')
    const label = edits.length > 1 ? `Edit ${i + 1}` : 'The edit'
    if (!find) return { ok: false, error: `${label} has an empty "find".` }
    const at = out.indexOf(find)
    if (at < 0) return { ok: false, error: `${label} did not apply: its "find" text is not in the diagram. Copy it exactly from the current code.` }
    if (out.indexOf(find, at + 1) >= 0) return { ok: false, error: `${label} did not apply: its "find" text appears more than once. Include more of the line so it is unique.` }
    out = out.slice(0, at) + e.replace.replace(/\r\n?/g, '\n') + out.slice(at + find.length)
  }
  return { ok: true, code: out }
}

export interface DiffLine {
  kind: 'same' | 'added' | 'removed'
  text: string
  /** Line number in the old text (absent for added lines). */
  a?: number
  /** Line number in the new text (absent for removed lines). */
  b?: number
}

/** Line-by-line difference between two texts (longest common subsequence), removals before additions. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n')
  const b = after.replace(/\r\n?/g, '\n').split('\n')
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]!, a: i + 1, b: j + 1 })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'removed', text: a[i]!, a: ++i })
    else out.push({ kind: 'added', text: b[j]!, b: ++j })
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i]!, a: ++i })
  while (j < b.length) out.push({ kind: 'added', text: b[j]!, b: ++j })
  return out
}

export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'added') added++
    else if (l.kind === 'removed') removed++
  }
  return { added, removed }
}

/** "+3 −1" for a tool pill or a tab label; empty when nothing changed. */
export function diffLabel(before: string, after: string): string {
  const { added, removed } = diffStat(lineDiff(before, after))
  return [added ? `+${added}` : '', removed ? `−${removed}` : ''].filter(Boolean).join(' ')
}

const FENCE = /```mermaid[^\n]*\n([\s\S]*?)(?:\n```|$)/g

/**
 * Mermaid blocks written straight into a reply: the reply with each block replaced by nothing, and the
 * blocks themselves. A block still being streamed (no closing fence yet) is left out until it closes.
 */
export function splitFences(text: string, streaming = false): { text: string; diagrams: string[] } {
  if (!text.includes('```mermaid')) return { text, diagrams: [] }
  const diagrams: string[] = []
  const out = text.replace(FENCE, (whole: string, body: string) => {
    const closed = whole.endsWith('\n```')
    if (body.trim() && (closed || !streaming)) diagrams.push(body.trim())
    return ''
  })
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), diagrams }
}
