import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { ExplorerModule } from '../explore'

export interface ExploreDeps {
  module: ExplorerModule
  /**
   * Hands a goal to the explorer module's loop (Settings > PC access > Explorer). When absent, pc_explore is not
   * offered and the assistant chains the read-only tools itself.
   */
  run?: (goal: string, mayEdit: boolean, signal?: AbortSignal) => Promise<unknown>
}

/**
 * The PC tools the voice model gets: the module's four read-only tools for a single step, and pc_explore, which
 * hands a whole goal to the module. Editing and the restricted terminal exist only inside the module's loop.
 */
export function exploreTools(deps: ExploreDeps): ToolSet {
  const tools = deps.module.readTools()
  const run = deps.run
  if (run) {
    const canEdit = deps.module.canEdit()
    tools.pc_explore = tool({
      description:
        `Hand a goal on the PC to the explorer, which works on it by itself until it is done (it searches by name, retries with other spellings and folders, searches inside files, lists and reads, and can run harmless commands such as git status and git log) and comes back with one short answer. Prefer it whenever the answer needs more than one step: "find my lemon AI project on the D drive", "what is in my thesis folder", "which of my projects uses FastAPI", "what changed last in the lemon repo".${canEdit ? ' It can also make a small change to a text file ("change the port in its config to 4200"): set may_edit for that.' : ''} It can never delete, move, create or run anything. For one known path, call pc_list or pc_read directly instead.`,
      inputSchema: z.object({
        goal: z.string().min(3).describe('What to get done, self-contained: the names the user said, the drive or folder if they gave one, and what you need back (the path, what it is, what it contains). For a change: which file or project, and exactly what to change to what.'),
        may_edit: z.boolean().default(false).describe('true only when the user asked for a file to be changed. Leave false for anything that only looks.')
      }),
      execute: ({ goal, may_edit }, { abortSignal }) => run(goal, may_edit, abortSignal)
    })
  }
  return tools
}
