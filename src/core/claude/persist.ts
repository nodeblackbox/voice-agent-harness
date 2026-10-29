/**
 * On-disk form of session timelines, so "what did it do?" still has an answer after a restart. Pure: the
 * service decides when to read and write. Events are compacted (the live buffer keeps 8k-character texts
 * and 60-entry arrays; the saved copy keeps less) and capped per session.
 */
import type { CcEvent, CcSession } from '@shared/claude'
import { clip } from './events'

const TEXT = 4000
const INPUT_TEXT = 1000
const INPUT_ITEMS = 20

export function compactEvent(e: CcEvent): CcEvent {
  const out: CcEvent = { ...e, text: clip(e.text ?? '', TEXT) }
  if (e.input) {
    const input: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(e.input)) {
      input[k] = typeof v === 'string' ? clip(v, INPUT_TEXT) : Array.isArray(v) ? v.slice(0, INPUT_ITEMS) : v
    }
    out.input = input
  }
  return out
}

/** JSON for the events file: { [sessionId]: CcEvent[] } for the sessions that still exist. */
export function serializeEvents(sessions: CcSession[], eventsOf: (id: string) => CcEvent[], cap = 200): string {
  const out: Record<string, CcEvent[]> = {}
  for (const s of sessions) {
    const events = eventsOf(s.id).slice(-cap).map(compactEvent)
    if (events.length) out[s.id] = events
  }
  return JSON.stringify(out)
}

/** The events file read back; anything malformed is dropped rather than failing the restore. */
export function parseEvents(text: string): Record<string, CcEvent[]> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, CcEvent[]> = {}
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const events = list.filter((e): e is CcEvent => !!e && typeof e === 'object' && typeof (e as CcEvent).t === 'number' && typeof (e as CcEvent).kind === 'string')
    if (events.length) out[id] = events
  }
  return out
}
