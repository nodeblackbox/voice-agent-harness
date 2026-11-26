// The voice model's playbook tools: list, write (create or change from a brief), switch on/off, delete and
// undo. A brief goes to the drafter (core/playbooks/author.ts), which writes the file and checks it with the
// loader's parser; saving and history are the main process's job (PlaybookAdmin). Deleting needs a clear yes:
// the first call only asks, and the same id confirmed within two minutes deletes.

import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { PlaybookInfo, PlaybookSaveResult, PlaybooksState, PlaybookTestRow } from '@shared/types'
import type { DraftResult } from '../playbooks/author'

export interface PlaybookAdmin {
  state(): PlaybooksState
  save(id: string, text: string, previousId?: string, by?: 'ui' | 'voice'): PlaybookSaveResult
  toggle(id: string, on: boolean, by?: 'ui' | 'voice'): PlaybookSaveResult
  delete(id: string, by?: 'ui' | 'voice'): void
  /** Undo the last change to the folder (any of the above, by voice or by hand in the view). */
  undo(): Promise<{ ok: boolean; message: string }>
}

export interface PlaybookToolDeps {
  admin: PlaybookAdmin
  /** Writes the file for a brief; `current` when changing an existing one. */
  draft(brief: string, current?: { id: string; source: string }): Promise<DraftResult>
  /** Replays recent messages against a file without Jev (cheap, instant); null when not possible. */
  replay?(id: string, text: string): Promise<PlaybookTestRow[] | null>
  trace?(ev: string, data: Record<string, unknown>): void
  now?(): number
  /**
   * Deletes asked about and not yet confirmed (id -> when). The tools are rebuilt every turn and the yes comes in a
   * later turn, so this must be owned by something that lives longer: the agent passes its own map.
   */
  pendingDeletes?: Map<string, number>
}

export const CONFIRM_WINDOW_MS = 120_000

/** What it reacts to, in a few words, for the model to say back. */
export function triggerSummary(p: PlaybookInfo): string {
  const parts: string[] = []
  if (p.when) parts.push(`when ${p.when}`)
  if (p.said?.length) parts.push(`when you say ${p.said.map((s) => `"${s}"`).join(' or ')}`)
  if (p.ask) parts.push(`when Jev answers yes to "${p.ask}"`)
  return parts.join(', and ') || 'on every message'
}

function brief(p: PlaybookInfo) {
  return p.ok
    ? { id: p.id, title: p.title, on: p.enabled, fires: triggerSummary(p), goal: p.goal, needs_jev: !!p.usesJev, fired_this_run: p.firedCount }
    : { id: p.id, broken: p.errors[0] ? `line ${p.errors[0].line}: ${p.errors[0].message}` : 'unreadable' }
}

export function playbookTools(deps: PlaybookToolDeps): ToolSet {
  const now = deps.now ?? Date.now
  const pendingDelete = deps.pendingDeletes ?? new Map<string, number>()

  /** By file name, or by title when the model only knows that. */
  const find = (ref: string): PlaybookInfo | undefined => {
    const list = deps.admin.state().playbooks
    const r = ref.trim().toLowerCase().replace(/\.md$/, '')
    return list.find((p) => p.id === r) ?? list.find((p) => p.title?.toLowerCase() === r) ?? list.find((p) => !!p.title && p.title.toLowerCase().includes(r))
  }
  const missing = (ref: string) => ({ status: 'not_found', note: `No playbook called "${ref}". Call playbook_list for the names.` })

  return {
    playbook_list: tool({
      description: 'List the playbooks: situations you recognise in what the user says, each with its trigger and whether it is on. Use it before changing one, or when asked which playbooks there are.',
      inputSchema: z.object({}),
      execute: async () => {
        const s = deps.admin.state()
        return { playbooks: s.playbooks.map(brief), jev: s.jev === 'ready' ? 'available' : s.jev === 'off' ? 'switched off' : 'no TypeSafe key, so playbooks that need Jev never fire' }
      }
    }),

    playbook_write: tool({
      description:
        'Create a playbook, or change one, from a brief. A playbook makes you handle a recurring situation a set way: "whenever I ramble, break it down", "when I say push the changes, offer to push", "stop asking me follow-up questions after short answers". The drafter writes and checks the file; it is saved and active at once. Then say in one sentence what it reacts to and what it makes you do.',
      inputSchema: z.object({
        brief: z
          .string()
          .min(10)
          .describe('Self-contained: the situation to recognise (the words the user would say, or the kind of message), what you should do then, and anything they said about how often or how strictly. It cannot see this conversation.'),
        id: z.string().optional().describe('To change an existing playbook: its name from playbook_list. Leave out to create a new one.')
      }),
      execute: async ({ brief: b, id }) => {
        const current = id ? find(id) : undefined
        if (id && !current) return missing(id)
        const t0 = now()
        let r: DraftResult
        try {
          r = await deps.draft(b, current ? { id: current.id, source: current.source } : undefined)
        } catch (e) {
          deps.trace?.('playbook.draft', { ok: false, ms: now() - t0, error: (e as Error).message })
          return { status: 'error', note: `The drafter failed: ${(e as Error).message}. Nothing was saved.` }
        }
        deps.trace?.('playbook.draft', { ok: r.ok, id: r.ok ? r.id : current?.id, ms: now() - t0, repaired: r.ok ? r.repaired : true, errors: r.ok ? undefined : r.errors.slice(0, 3).map((e) => e.message) })
        if (!r.ok) return { status: 'invalid', errors: r.errors.slice(0, 5).map((e) => (e.line ? `line ${e.line}: ${e.message}` : e.message)), note: 'The draft did not load, so nothing was saved. Tell the user in a sentence; they can try again with a clearer brief or write it in the Playbooks view.' }
        const saved = deps.admin.save(r.id, r.text, current?.id, 'voice')
        if (!saved.ok) return { status: 'invalid', errors: saved.errors.map((e) => e.message), note: 'Nothing was saved.' }
        const p = deps.admin.state().playbooks.find((x) => x.id === saved.id)
        const out: Record<string, unknown> = { status: current ? 'changed' : 'created', ...(p ? brief(p) : { id: saved.id }) }
        if (r.warnings.length) out.warnings = r.warnings.map((w) => w.message)
        if (p?.usesJev && deps.admin.state().jev !== 'ready') out.note = 'It needs Jev, which is not available (no TypeSafe key, or switched off), so it will not fire until it is. Say so.'
        if (deps.replay && p && !p.usesJev) {
          const rows = await deps.replay(saved.id, r.text).catch(() => null)
          if (rows?.length) out.recent = `would have fired on ${rows.filter((x) => x.why).length} of the user's last ${rows.length} messages`
        }
        return out
      }
    }),

    playbook_switch: tool({
      description: 'Switch a playbook on or off without deleting it, e.g. "stop breaking my messages down" or "turn the idea one back on".',
      inputSchema: z.object({ id: z.string().describe('Its name or title'), on: z.boolean() }),
      execute: async ({ id, on }) => {
        const p = find(id)
        if (!p) return missing(id)
        const r = deps.admin.toggle(p.id, on, 'voice')
        return r.ok ? { status: on ? 'on' : 'off', id: p.id, title: p.title } : { status: 'error', note: r.errors[0]?.message }
      }
    }),

    playbook_delete: tool({
      description:
        'Delete a playbook, in two calls. First call it WITHOUT confirmed as soon as the user asks for a delete: it deletes nothing and returns what would be deleted. Then ask the user. Only after a clear yes, call it again with confirmed true. A confirmed call without that first call deletes nothing. Offer playbook_switch (off) instead when they might want it back.',
      inputSchema: z.object({ id: z.string().describe('Its name or title'), confirmed: z.boolean().default(false) }),
      execute: async ({ id, confirmed }) => {
        const p = find(id)
        if (!p) return missing(id)
        const asked = pendingDelete.get(p.id)
        const fresh = asked !== undefined && now() - asked <= CONFIRM_WINDOW_MS
        if (confirmed && !fresh) {
          // the yes came without the first call (or too long after it): nothing happens, and the model must not say otherwise
          pendingDelete.set(p.id, now())
          return { status: 'not_deleted', id: p.id, title: p.title ?? p.id, note: 'NOT deleted: the first call (without confirmed) had not been made. Tell the user plainly it is not deleted yet and ask once more; after their yes, call again with confirmed true.' }
        }
        if (!confirmed) {
          pendingDelete.set(p.id, now())
          return { status: 'needs_confirmation', id: p.id, title: p.title ?? p.id, note: 'Nothing deleted yet. Ask the user whether to delete it (it can be undone). Call again with confirmed true only after a clear yes.' }
        }
        pendingDelete.delete(p.id)
        deps.admin.delete(p.id, 'voice')
        return { status: 'deleted', id: p.id, title: p.title, note: 'It can be brought back with playbook_undo.' }
      }
    }),

    playbook_undo: tool({
      description: 'Undo the last change to the playbooks (a create, change, switch or delete), e.g. "undo that" right after one.',
      inputSchema: z.object({}),
      execute: async () => deps.admin.undo()
    })
  }
}
