// The `schedule` trigger: when a runbook runs by the clock. Pure, so the engine decides with it and the
// Playbooks page describes it with the same rules.

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Day = (typeof DAYS)[number]

export const DAY_NAMES: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

/** weekday field ("monday") to its short form ("mon"). */
export const dayOf = (weekday: string): Day | undefined => DAYS.find((d) => weekday.toLowerCase().startsWith(d))

export interface Schedule {
  /** Times of day, "HH:MM" (24-hour). */
  at: string[]
  /** Every this many minutes, counted from `from` (or midnight). */
  every: number | null
  /** Days it runs on; empty means every day. */
  days: Day[]
  /** With `every`: the part of the day it runs in, "HH:MM". */
  from: string | null
  until: string | null
}

export const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function minutesOf(time: string): number | null {
  const m = TIME.exec(time.trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
export const clockTime = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`

/** Whether the schedule runs in this minute. `weekday` is the clock's "monday" … "sunday". */
export function scheduleDue(s: Schedule, now: { hour: number; minute: number; weekday: string }): boolean {
  const day = dayOf(now.weekday)
  if (s.days.length && (!day || !s.days.includes(day))) return false
  const t = now.hour * 60 + now.minute
  if (s.at.some((a) => minutesOf(a) === t)) return true
  if (s.every && s.every > 0) {
    const from = (s.from ? minutesOf(s.from) : null) ?? 0
    const until = (s.until ? minutesOf(s.until) : null) ?? 24 * 60 - 1
    if (t < from || t > until) return false
    return (t - from) % s.every === 0
  }
  return false
}

/** "Mon–Fri", "weekends", "Mon, Wed and Fri", or "" for every day. */
export function describeDays(days: readonly Day[]): string {
  const set = DAYS.filter((d) => days.includes(d))
  if (!set.length || set.length === 7) return ''
  const key = set.join(',')
  if (key === 'mon,tue,wed,thu,fri') return 'on weekdays'
  if (key === 'sat,sun') return 'at weekends'
  const names = set.map((d) => DAY_NAMES[d].slice(0, 3))
  return `on ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`
}

function every(n: number): string {
  if (n % 60 === 0) return n === 60 ? 'every hour' : `every ${n / 60} hours`
  return n === 1 ? 'every minute' : `every ${n} minutes`
}

/** A schedule in words: "at 09:00 and 17:30 on weekdays", "every 20 minutes from 09:00 to 18:00". */
export function describeSchedule(s: Partial<Schedule> | null | undefined): string {
  if (!s) return 'no schedule set'
  const parts: string[] = []
  const at = (s.at ?? []).filter((a) => minutesOf(a) !== null).map((a) => clockTime(minutesOf(a)!))
  if (at.length) parts.push(`at ${at.length > 1 ? `${at.slice(0, -1).join(', ')} and ${at.at(-1)}` : at[0]}`)
  if (s.every) {
    const window = s.from || s.until ? ` from ${s.from ?? '00:00'} to ${s.until ?? '23:59'}` : ''
    parts.push(`${every(s.every)}${window}`)
  }
  if (!parts.length) return 'no time set'
  const days = describeDays(s.days ?? [])
  return `${parts.join(', and ')}${days ? ` ${days}` : ''}`
}

/** The next minutes it runs at, from `after` (exclusive), looking a week ahead at most. */
export function nextRuns(s: Schedule, after: Date, count = 3): Date[] {
  const out: Date[] = []
  const d = new Date(after)
  d.setSeconds(0, 0)
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  for (let i = 0; i < 7 * 24 * 60 && out.length < count; i++) {
    d.setMinutes(d.getMinutes() + 1)
    if (scheduleDue(s, { hour: d.getHours(), minute: d.getMinutes(), weekday: names[d.getDay()]! })) out.push(new Date(d))
  }
  return out
}
