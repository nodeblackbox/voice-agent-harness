// Every trigger event the app has, in words: one catalogue for the form's event picker, the trigger sentence,
// the sidebar line and the Triggers overview, so they all say the same thing.
import { AlarmClock, CalendarClock, CircleAlert, CircleCheck, Coffee, Gauge, Hand, MessageSquare, Play, Power, Shrink, type LucideIcon } from 'lucide-react'
import type { Schedule } from '@shared/schedule'

export type EventGroup = 'you' | 'sessions' | 'time'

export interface EventInfo {
  id: string
  /** Card title: "A session finishes". */
  label: string
  /** In a sentence: "It fires when a Claude Code session finishes". */
  words: string
  help: string
  group: EventGroup
  icon: LucideIcon
  /** A condition to start from when it is picked (only when the condition box is empty). */
  suggest?: string
}

export const EVENTS: EventInfo[] = [
  { id: 'turn.user', label: 'You say something', words: 'you say something', help: 'Every message, spoken or typed.', group: 'you', icon: MessageSquare },
  { id: 'cc.finished', label: 'A session finishes', words: 'a Claude Code session finishes', help: 'It ends a job and has its answer.', group: 'sessions', icon: CircleCheck },
  { id: 'cc.needs_input', label: 'A session needs you', words: 'a session needs you', help: 'A question, a permission or a plan to approve.', group: 'sessions', icon: Hand },
  { id: 'cc.started', label: 'A session starts', words: 'a Claude Code session starts', help: 'A new session is created.', group: 'sessions', icon: Play },
  { id: 'cc.error', label: 'A session fails', words: 'a Claude Code session fails', help: 'A run errors or loses its connection.', group: 'sessions', icon: CircleAlert },
  { id: 'cc.idle', label: 'A session sits idle', words: 'a session has sat idle', help: 'Finished, with nothing to do, for a while.', group: 'sessions', icon: Coffee, suggest: 'idleMinutes == 30' },
  { id: 'cc.context', label: 'Its context fills up', words: "a session's context fills past another tenth", help: 'Each time it passes 10%, 20% … on the way up.', group: 'sessions', icon: Gauge, suggest: 'percent >= 80' },
  { id: 'cc.compacted', label: 'A session is compacted', words: 'a session is compacted', help: 'Its conversation was summarised to free room.', group: 'sessions', icon: Shrink },
  { id: 'schedule', label: 'On a schedule', words: 'the schedule is due', help: 'At set times, or every few minutes.', group: 'time', icon: CalendarClock },
  { id: 'app.start', label: 'The app starts', words: 'the app starts', help: 'Once, a few seconds after it opens.', group: 'time', icon: Power },
  { id: 'clock.tick', label: 'Every minute', words: 'a minute passes', help: 'For a condition on the time; prefer a schedule.', group: 'time', icon: AlarmClock }
]

export const GROUPS: Array<{ id: EventGroup; label: string }> = [
  { id: 'you', label: 'You' },
  { id: 'sessions', label: 'Claude Code sessions' },
  { id: 'time', label: 'Time' }
]

export const EVENT_BY_ID: Record<string, EventInfo> = Object.fromEntries(EVENTS.map((e) => [e.id, e]))

/** In a sentence; a prefix such as "cc." covers a group. */
export function eventWords(id: string): string {
  if (EVENT_BY_ID[id]) return EVENT_BY_ID[id].words
  if (id === 'cc.') return 'any Claude Code session event'
  if (id === 'clock.') return 'the clock'
  return id
}

/** Where an event (or a prefix of several) sits in the overview. */
export function groupOf(id: string): EventGroup {
  return EVENT_BY_ID[id]?.group ?? (id.startsWith('cc.') ? 'sessions' : id === 'turn.user' ? 'you' : 'time')
}

export const DEFAULT_SCHEDULE: Schedule = { at: ['09:00'], every: null, days: ['mon', 'tue', 'wed', 'thu', 'fri'], from: null, until: null }
