import { MAX_DIAGRAM_CHARS, cleanCode, latest, summarize, type DiagramDoc, type DiagramSummary } from '@shared/diagram'

/** Where diagrams are kept; the main process backs this with one JSON file per diagram. */
export interface DiagramFiles {
  all(): DiagramDoc[]
  write(doc: DiagramDoc): void
  remove(id: string): void
}

/** Versions kept per diagram; the oldest are dropped past this (the first is always kept). */
export const MAX_VERSIONS = 60

const newId = (taken: (id: string) => boolean): string => {
  for (;;) {
    const id = `d${Math.random().toString(36).slice(2, 7)}`
    if (id.length === 6 && !taken(id)) return id
  }
}

/**
 * Every diagram drawn in the app, each with its history. The agent's tools and the owner's edits in the
 * chat both go through here, so each always sees the other's latest version.
 */
export class DiagramLibrary {
  private readonly docs = new Map<string, DiagramDoc>()

  constructor(
    private readonly files: DiagramFiles,
    private readonly onChange: (doc: DiagramDoc | null, id: string) => void = () => {},
    private readonly now: () => number = Date.now
  ) {
    for (const d of files.all()) if (d?.id && Array.isArray(d.versions) && d.versions.length) this.docs.set(d.id, d)
  }

  list(): DiagramSummary[] {
    return [...this.docs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summarize)
  }

  get(id: string): DiagramDoc | undefined {
    return this.docs.get(id)
  }

  /**
   * The diagram someone means: by id, by (part of) its title, or with nothing said, the one last touched
   * in this chat, then the one last touched anywhere.
   */
  find(ref: string | undefined, sessionId?: string): DiagramDoc | undefined {
    const all = [...this.docs.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    const r = ref?.trim().toLowerCase()
    if (r) {
      const words = r.split(/\s+/).filter((w) => w.length > 2 && w !== 'the' && w !== 'diagram')
      return (
        this.docs.get(r) ??
        all.find((d) => d.title.toLowerCase() === r) ??
        all.find((d) => d.title.toLowerCase().includes(r)) ??
        (words.length ? all.find((d) => words.every((w) => d.title.toLowerCase().includes(w))) : undefined)
      )
    }
    return all.find((d) => sessionId && d.sessionId === sessionId) ?? all[0]
  }

  create(x: { title: string; code: string; sessionId?: string; by: 'agent' | 'user'; note?: string }): DiagramDoc {
    const at = this.now()
    const doc: DiagramDoc = {
      id: newId((id) => this.docs.has(id)),
      title: x.title.trim().slice(0, 80) || 'Untitled diagram',
      sessionId: x.sessionId,
      createdAt: at,
      updatedAt: at,
      versions: [{ n: 1, code: clip(cleanCode(x.code)), at, by: x.by, note: x.note }]
    }
    return this.put(doc)
  }

  /** Add a version (and optionally rename). Saving the same code again adds nothing. */
  commit(id: string, x: { code?: string; by: 'agent' | 'user'; note?: string; title?: string }): { doc: DiagramDoc; changed: boolean } | undefined {
    const doc = this.docs.get(id)
    if (!doc) return undefined
    const code = x.code === undefined ? undefined : clip(cleanCode(x.code))
    const title = x.title?.trim().slice(0, 80)
    const newCode = code !== undefined && code !== latest(doc).code
    const newTitle = !!title && title !== doc.title
    if (!newCode && !newTitle) return { doc, changed: false }
    const at = this.now()
    let versions = doc.versions
    if (newCode) {
      versions = [...versions, { n: latest(doc).n + 1, code: code!, at, by: x.by, note: x.note }]
      if (versions.length > MAX_VERSIONS) versions = [versions[0]!, ...versions.slice(versions.length - MAX_VERSIONS + 1)]
    }
    return { doc: this.put({ ...doc, title: newTitle ? title! : doc.title, updatedAt: at, versions }), changed: true }
  }

  remove(id: string): boolean {
    if (!this.docs.delete(id)) return false
    this.files.remove(id)
    this.onChange(null, id)
    return true
  }

  private put(doc: DiagramDoc): DiagramDoc {
    this.docs.set(doc.id, doc)
    this.files.write(doc)
    this.onChange(doc, doc.id)
    return doc
  }
}

const clip = (code: string): string => (code.length > MAX_DIAGRAM_CHARS ? code.slice(0, MAX_DIAGRAM_CHARS) : code)
