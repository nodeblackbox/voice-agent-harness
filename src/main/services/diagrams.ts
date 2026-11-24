import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DiagramCheck, DiagramDoc } from '@shared/diagram'
import { IPC } from '@shared/ipc'
import { DiagramLibrary, type DiagramFiles } from '@core/diagrams/library'
import { log, logError } from './log'

/** How long the window gets to answer a parse check (the first one also loads Mermaid). */
const CHECK_TIMEOUT_MS = 8000

/** One JSON file per diagram, with its whole history, in `<userData>/diagrams`. */
function files(dir: string): DiagramFiles {
  const path = (id: string): string => join(dir, `${id.replace(/[^a-z0-9_-]/gi, '')}.json`)
  return {
    all() {
      if (!existsSync(dir)) return []
      const out: DiagramDoc[] = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        try {
          out.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as DiagramDoc)
        } catch (e) {
          logError('diagrams', `unreadable ${name}`, e)
        }
      }
      return out
    },
    write(doc) {
      try {
        mkdirSync(dir, { recursive: true })
        const tmp = `${path(doc.id)}.tmp`
        writeFileSync(tmp, JSON.stringify(doc, null, 1), 'utf8')
        renameSync(tmp, path(doc.id))
      } catch (e) {
        logError('diagrams', `could not save ${doc.id}`, e)
      }
    },
    remove(id) {
      rmSync(path(id), { force: true })
    }
  }
}

/**
 * Owns the diagram library on disk, and asks the window to run Mermaid's parser when the agent draws:
 * Mermaid needs a real browser, so the check is a round trip to the renderer.
 */
export class DiagramService {
  readonly library: DiagramLibrary
  private readonly waiting = new Map<string, (r: DiagramCheck | null) => void>()

  constructor(
    userData: string,
    private readonly send: (channel: string, ...args: unknown[]) => void,
    onChange: (doc: DiagramDoc | null, id: string) => void
  ) {
    this.library = new DiagramLibrary(files(join(userData, 'diagrams')), onChange)
    log('diagrams', `${this.library.list().length} diagrams loaded`)
  }

  check = (code: string): Promise<DiagramCheck | null> =>
    new Promise((resolve) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        log('diagrams', 'the window did not answer a parse check; keeping the diagram unchecked')
        resolve(null)
      }, CHECK_TIMEOUT_MS)
      this.waiting.set(id, (r) => {
        clearTimeout(timer)
        this.waiting.delete(id)
        resolve(r)
      })
      this.send(IPC.diagramCheck, id, code)
    })

  /** The window's answer to a check. */
  checked(id: string, result: DiagramCheck | null): void {
    this.waiting.get(id)?.(result && typeof result === 'object' && 'ok' in result ? result : null)
  }
}
