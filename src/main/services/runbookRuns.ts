// Where runbook runs are kept: one JSON file per run in `<userData>/runbooks/runs`, written after every step, so a
// run waiting for the user's reply is still there after a restart. Old finished runs are removed.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunbookRun } from '@shared/types'

const KEEP = 50

export class RunbookRunStore {
  constructor(
    readonly dir: string,
    private log: (msg: string) => void = () => undefined
  ) {}

  save(run: RunbookRun): void {
    if (!/^[0-9a-z-]{8,64}$/i.test(run.runId)) return
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(join(this.dir, `${run.runId}.json`), JSON.stringify(run, null, 1))
  }

  /** Every saved run, newest first; the oldest finished ones beyond KEEP are deleted on the way. */
  load(): RunbookRun[] {
    if (!existsSync(this.dir)) return []
    const runs: RunbookRun[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        runs.push(JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as RunbookRun)
      } catch (e) {
        this.log(`runbooks: unreadable run ${name}: ${(e as Error).message}`)
      }
    }
    runs.sort((a, b) => b.startedAt - a.startedAt)
    const finished = runs.filter((r) => r.status !== 'running' && r.status !== 'waiting')
    for (const old of finished.slice(KEEP)) rmSync(join(this.dir, `${old.runId}.json`), { force: true })
    const dropped = new Set(finished.slice(KEEP).map((r) => r.runId))
    return runs.filter((r) => !dropped.has(r.runId))
  }
}
