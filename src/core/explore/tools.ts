/**
 * The explorer module's tools as the models see them. Every call goes through `act`, which times it, sorts the
 * outcome into ok / refused / error and writes one line to the action log, whoever made the call.
 */
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { editFile } from './edit'
import type { PcExplorer } from './fs'
import { SHELL_COMMANDS, type RestrictedShell } from './shell'

/** One thing the module did or refused to do; the log gets every one. */
export interface ExploreAction {
  t: number
  /** `assistant` = the voice model called the tool itself; `explorer` = a step of the goal loop. */
  by: 'assistant' | 'explorer'
  /** The goal being worked on, for the loop's steps. */
  goal?: string
  tool: string
  input: string
  outcome: 'ok' | 'refused' | 'error'
  detail: string
  ms: number
}

export interface ToolContext {
  fs: PcExplorer
  shell: RestrictedShell
  backupDir?: string
  log?: (a: ExploreAction) => void
  by: ExploreAction['by']
  goal?: string
  /** Offer pc_edit / pc_run. Both are off for the assistant's own direct tools. */
  edit?: boolean
  terminal?: boolean
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
const REFUSAL = /outside the folders|never read|never opened|credentials|device name|not allowed|valid path|No folders are approved/

/** ok, refused or error, and a few words on what came back, from any tool's output. */
export function outcomeOf(output: unknown): { outcome: ExploreAction['outcome']; detail: string } {
  const o = (output ?? {}) as Record<string, unknown>
  if (typeof o.refused === 'string') return { outcome: 'refused', detail: clip(o.refused, 200) }
  if (typeof o.error === 'string') return { outcome: REFUSAL.test(o.error) ? 'refused' : 'error', detail: clip(o.error, 200) }
  if (o.status === 'edited') return { outcome: 'ok', detail: `replaced ${String(o.replaced)} at line ${String(o.line)}; backup ${String(o.backup)}` }
  if (Array.isArray(o.matches)) return { outcome: 'ok', detail: `${o.matches.length} match${o.matches.length === 1 ? '' : 'es'}${o.incomplete ? ' (stopped early)' : ''}` }
  if (Array.isArray(o.folders) && Array.isArray(o.files)) return { outcome: 'ok', detail: `${String(o.total_folders ?? o.folders.length)} folders, ${String(o.total_files ?? o.files.length)} files` }
  if (Array.isArray(o.approved_folders)) return { outcome: 'ok', detail: `${o.approved_folders.length} approved folders` }
  if (typeof o.text === 'string') return { outcome: 'ok', detail: `lines ${String(o.lines ?? '?')}` }
  if (typeof o.output === 'string') return { outcome: 'ok', detail: `${o.output.split('\n').length} lines of output` }
  return { outcome: 'ok', detail: '' }
}

/** What a call was aimed at, in a few words: `"lemon ai" in D:\`, a path, or a command line. */
export function inputOf(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  if (typeof i.command === 'string') return clip(`${i.command}${typeof i.cwd === 'string' && i.cwd ? `  (in ${i.cwd})` : ''}`, 240)
  const what = typeof i.query === 'string' ? `"${i.query}"` : typeof i.text === 'string' ? `"${i.text}"` : ''
  const where = typeof i.path === 'string' && i.path ? `${what ? ' in ' : ''}${i.path}` : ''
  return clip(`${what}${where}`, 240)
}

export function exploreToolSet(ctx: ToolContext): ToolSet {
  const act = async <T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now()
    let output: unknown
    try {
      output = await fn()
      return output as T
    } catch (e) {
      output = { error: `The ${name} tool failed (${(e as Error)?.message ?? 'unknown error'}).` }
      return output as T
    } finally {
      ctx.log?.({ t, by: ctx.by, goal: ctx.goal, tool: name, input: inputOf(input), ms: Date.now() - t, ...outcomeOf(output) })
    }
  }

  const tools: ToolSet = {
    pc_find: tool({
      description:
        "Find files or folders on the user's PC by name, inside the folders they approved. Plain words match loosely (\"lemon ai\" finds LemonAI, lemon-ai-app, Lemon_AI); use * and ? for a pattern (\"*.pdf\", \"report*2026*\"). Nearest matches first. Use it when the user asks where something is, or names a project or file without saying where it lives.",
      inputSchema: z.object({
        query: z.string().min(1).describe('Words from the name, or a pattern with * or ?'),
        path: z.string().default('').describe('Folder to search in, e.g. "D:\\" or "D:\\Projects". Empty = every approved folder.'),
        type: z.enum(['any', 'folder', 'file']).default('any').describe('"folder" when looking for a project or directory'),
        limit: z.number().int().min(1).max(50).default(15)
      }),
      execute: (i, { abortSignal }) => act('pc_find', i, () => ctx.fs.find(i.query, { path: i.path, type: i.type, limit: i.limit, signal: abortSignal }))
    }),
    pc_list: tool({
      description:
        'List what is in a folder on the PC: its sub-folders and its files with sizes and dates. With no path it returns the folders the user approved, which is where to start when you do not know where you may look. Use it to see what a project contains.',
      inputSchema: z.object({
        path: z.string().default('').describe('Full path of the folder, e.g. "D:\\Projects\\lemon-ai". Empty = show the approved folders.'),
        limit: z.number().int().min(1).max(200).default(60)
      }),
      execute: (i) => act('pc_list', i, () => ctx.fs.list(i.path, i.limit))
    }),
    pc_read: tool({
      description:
        'Read a text file on the PC (code, notes, README, config, logs): up to about 6000 characters from a given line. Use it to learn what a project is (read its README or package.json) or to answer from a document. Binary files and files that hold passwords or keys are refused.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Full path of the file'),
        from_line: z.number().int().min(1).default(1).describe('Line to start at; use the number the previous read told you to continue from'),
        max_chars: z.number().int().min(200).max(12000).default(6000)
      }),
      execute: (i) => act('pc_read', i, () => ctx.fs.read(i.path, { fromLine: i.from_line, maxChars: i.max_chars }))
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
      execute: (i, { abortSignal }) => act('pc_grep', i, () => ctx.fs.grep(i.text, { path: i.path, files: i.files, regex: i.regex, limit: i.limit, signal: abortSignal }))
    })
  }

  if (ctx.terminal) {
    tools.pc_run = tool({
      description: `Run one harmless, read-only command in an approved folder and get its output. Only these exist: ${SHELL_COMMANDS.join(', ')}. One command per call; a pipe may lead only into grep, findstr, head, tail, wc or sort. No ;, &&, >, <, $ or backticks. Anything else is refused with the reason: do not try to get round a refusal.`,
      inputSchema: z.object({
        command: z.string().min(1).max(500).describe('e.g. git log --oneline -5   |   ls src   |   grep -rn "port" src --include=*.ts'),
        cwd: z.string().default('').describe('Full path of the folder to run in; needed when more than one folder is approved')
      }),
      execute: (i, { abortSignal }) =>
        act('pc_run', i, async () => {
          const r = await ctx.shell.run(i.command, i.cwd, abortSignal)
          return r.ok ? { output: r.output } : r
        })
    })
  }

  if (ctx.edit) {
    tools.pc_edit = tool({
      description:
        'Change an existing text file by replacing one piece of text with another. Read the file first and copy the text to replace exactly; it must occur once (include more of the surrounding lines if it does not), unless every occurrence is wanted. This cannot create, delete, rename or empty a file. A copy of the file as it was is kept. Use it only for the change the goal asks for.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Full path of the file'),
        find: z.string().min(1).describe('The exact text to replace, as it stands in the file'),
        replace: z.string().describe('The text to put in its place'),
        all: z.boolean().default(false).describe('Replace every occurrence')
      }),
      execute: (i) =>
        act('pc_edit', { path: i.path }, async () => {
          const r = await editFile(ctx.fs, i, { backupDir: ctx.backupDir })
          return r.ok ? { status: 'edited', path: r.path, replaced: r.replaced, line: r.line, backup: r.backup } : r
        })
    })
  }
  return tools
}
