/**
 * The explorer module: everything the assistant can do on the user's PC, behind one door.
 *
 *   fs.ts      the fence (approved folders, `..`, symlinks, junctions, secrets) and the four read operations
 *   edit.ts    the only write: replace text inside an existing file, with a backup copy first
 *   shell.ts   the restricted terminal: an allowlist of read-only commands, answered here; git is the only program run
 *   tools.ts   the tools as a model sees them, each call written to the action log
 *   agent.ts   the goal loop: works on a goal until it is done, within a step cap and a time cap
 *   roots.ts   the approved-folder list behind Settings > PC access
 *
 * Nothing outside this folder touches the file system for the assistant. The rest of the app uses `ExplorerModule`:
 * `run(goal)` for a goal, `readTools()` for the read-only tools the assistant may call itself.
 */
import type { LanguageModel, ToolSet } from 'ai'
import { PcExplorer, type ExplorerOptions } from './fs'
import { RestrictedShell, type ShellOptions } from './shell'
import { exploreToolSet, type ExploreAction } from './tools'
import { runExplorer, type ExplorerResult } from './agent'

export type { ExploreAction } from './tools'
export type { ExplorerResult, ExplorerStatus } from './agent'
export { EXPLORER_MAX_MS, EXPLORER_MAX_STEPS } from './agent'

export interface ExplorerPermissions {
  /** pc_edit may be offered to a goal that asks for a change. */
  edit: boolean
  /** pc_run (the restricted terminal) may be offered. */
  terminal: boolean
}

export interface ExplorerModuleOptions {
  /** The approved folders, read fresh on every call so a change in Settings applies at once. */
  roots: () => string[]
  permissions: () => ExplorerPermissions
  /** Where the copy of a file is kept before an edit. Without it no edit is possible. */
  backupDir?: () => string | undefined
  /** Receives every action taken or refused, by the loop and by the assistant's own tool calls. */
  log?: (a: ExploreAction) => void
  fs?: ExplorerOptions
  shell?: ShellOptions
}

export interface GoalRun {
  goal: string
  /** True only when the user asked for a file to be changed. Even then Settings must allow edits. */
  mayEdit?: boolean
  model: LanguageModel
  context?: string
  maxSteps?: number
  budgetMs?: number
  signal?: AbortSignal
  trace?(ev: string, data?: Record<string, unknown>): void
}

export class ExplorerModule {
  readonly fs: PcExplorer
  readonly shell: RestrictedShell

  constructor(private readonly opts: ExplorerModuleOptions) {
    this.fs = new PcExplorer(opts.roots, opts.fs)
    this.shell = new RestrictedShell(this.fs, opts.shell)
  }

  roots(): string[] {
    return this.fs.roots()
  }

  /** Whether an edit can happen at all right now (Settings allow it and there is a backup folder). */
  canEdit(): boolean {
    return !!this.opts.backupDir?.() && !!this.opts.permissions().edit
  }

  /** The read-only tools the assistant may call itself for a single step. No edit, no terminal. */
  readTools(): ToolSet {
    return exploreToolSet({ fs: this.fs, shell: this.shell, log: this.opts.log, by: 'assistant' })
  }

  /** Work on a goal until it is done or a cap is hit, and return a short answer for the voice. */
  async run(g: GoalRun): Promise<ExplorerResult> {
    const perms = this.opts.permissions()
    const edit = !!g.mayEdit && this.canEdit()
    const tools = exploreToolSet({ fs: this.fs, shell: this.shell, backupDir: this.opts.backupDir?.(), log: this.opts.log, by: 'explorer', goal: g.goal, edit, terminal: !!perms.terminal })
    const result = await runExplorer({ model: g.model, tools, goal: g.goal, roots: this.roots(), context: g.context, maxSteps: g.maxSteps, budgetMs: g.budgetMs, signal: g.signal, trace: g.trace })
    if (g.mayEdit && !edit) return { ...result, note: [result.note, 'Editing files is switched off in Settings > PC access, so nothing was changed.'].filter(Boolean).join(' ') }
    return result
  }
}
