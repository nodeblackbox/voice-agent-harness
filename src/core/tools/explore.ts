import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { PcExplorer } from '../explore/fs'

export interface ExploreDeps {
  explorer: PcExplorer
  /**
   * The helper that chains look-ups by itself (Settings > PC access > Explorer helper). When absent, pc_explore is
   * not offered and the model chains the four tools itself.
   */
  agent?: (request: string, signal?: AbortSignal) => Promise<unknown>
}

/** The four read-only tools; also what the explorer helper itself is given. */
export function pcReadTools(explorer: PcExplorer): ToolSet {
  return {
    pc_find: tool({
      description:
        "Find files or folders on the user's PC by name, inside the folders they approved. Plain words match loosely (\"lemon ai\" finds LemonAI, lemon-ai-app, Lemon_AI); use * and ? for a pattern (\"*.pdf\", \"report*2026*\"). Nearest matches first. Use it when the user asks where something is, or names a project or file without saying where it lives.",
      inputSchema: z.object({
        query: z.string().min(1).describe('Words from the name, or a pattern with * or ?'),
        path: z.string().default('').describe('Folder to search in, e.g. "D:\\" or "D:\\Projects". Empty = every approved folder.'),
        type: z.enum(['any', 'folder', 'file']).default('any').describe('"folder" when looking for a project or directory'),
        limit: z.number().int().min(1).max(50).default(15)
      }),
      execute: ({ query, path, type, limit }, { abortSignal }) => explorer.find(query, { path, type, limit, signal: abortSignal })
    }),
    pc_list: tool({
      description:
        'List what is in a folder on the PC: its sub-folders and its files with sizes and dates. With no path it returns the folders the user approved, which is where to start when you do not know where you may look. Use it to see what a project contains.',
      inputSchema: z.object({
        path: z.string().default('').describe('Full path of the folder, e.g. "D:\\Projects\\lemon-ai". Empty = show the approved folders.'),
        limit: z.number().int().min(1).max(200).default(60)
      }),
      execute: ({ path, limit }) => explorer.list(path, limit)
    }),
    pc_read: tool({
      description:
        'Read a text file on the PC (code, notes, README, config, logs): up to about 6000 characters from a given line. Use it to learn what a project is (read its README or package.json) or to answer from a document. Binary files and files that hold passwords or keys are refused.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Full path of the file'),
        from_line: z.number().int().min(1).default(1).describe('Line to start at; use the number the previous read told you to continue from'),
        max_chars: z.number().int().min(200).max(12000).default(6000)
      }),
      execute: ({ path, from_line, max_chars }) => explorer.read(path, { fromLine: from_line, maxChars: max_chars })
    }),
    pc_grep: tool({
      description:
        'Search inside text files on the PC for a word or phrase and get the matching lines with file and line number. Use it to find which file mentions something ("where is the port set", "which project uses FastAPI"). Give a folder to keep it quick; searching a whole drive is slow and stops early.',
      inputSchema: z.object({
        text: z.string().min(1).describe('The text to look for (plain text, any case)'),
        path: z.string().default('').describe('Folder or single file to search. Empty = every approved folder.'),
        files: z.string().default('').describe('Optional file-name pattern, e.g. "*.py" or "package.json"'),
        regex: z.boolean().default(false).describe('Treat text as a regular expression'),
        limit: z.number().int().min(1).max(50).default(20)
      }),
      execute: ({ text, path, files, regex, limit }, { abortSignal }) => explorer.grep(text, { path, files, regex, limit, signal: abortSignal })
    })
  }
}

/** The PC tools the voice model gets: the four read-only ones, plus pc_explore when the helper is on. */
export function exploreTools(deps: ExploreDeps): ToolSet {
  const tools = pcReadTools(deps.explorer)
  const agent = deps.agent
  if (agent) {
    tools.pc_explore = tool({
      description:
        'Hand a whole look-up on the PC to a helper that chains the steps itself (find by name, list the folder, read the README) and comes back with one short answer. Prefer it whenever the answer needs more than one step: "find my lemon AI project on the D drive", "what is in my thesis folder", "which of my projects uses FastAPI". For one known path, call pc_list or pc_read directly instead.',
      inputSchema: z.object({
        request: z.string().min(3).describe('What to find out, self-contained: the names the user said, the drive or folder if they gave one, and what you need back (the path, what it is, what it contains)')
      }),
      execute: ({ request }, { abortSignal }) => agent(request, abortSignal)
    })
  }
  return tools
}
