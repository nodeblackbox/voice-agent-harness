import { describe, expect, it } from 'vitest'
import { describeSchedule, nextRuns, scheduleDue, type Schedule } from './schedule'

const S = (o: Partial<Schedule>): Schedule => ({ at: [], every: null, days: [], from: null, until: null, ...o })
const at = (hour: number, minute: number, weekday = 'monday') => ({ hour, minute, weekday })

describe('schedule', () => {
  it('runs at set times, on the days given', () => {
    const s = S({ at: ['09:00', '17:30'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] })
    expect(scheduleDue(s, at(9, 0))).toBe(true)
    expect(scheduleDue(s, at(17, 30, 'friday'))).toBe(true)
    expect(scheduleDue(s, at(9, 1))).toBe(false)
    expect(scheduleDue(s, at(9, 0, 'saturday'))).toBe(false)
    expect(scheduleDue(S({ at: ['9:05'] }), at(9, 5, 'sunday'))).toBe(true)
  })

  it('repeats every N minutes inside its window, counted from the start', () => {
    const s = S({ every: 20, from: '09:10', until: '10:00' })
    expect([at(9, 10), at(9, 30), at(9, 50)].every((t) => scheduleDue(s, t))).toBe(true)
    expect(scheduleDue(s, at(9, 0))).toBe(false)
    expect(scheduleDue(s, at(9, 20))).toBe(false)
    expect(scheduleDue(s, at(10, 10))).toBe(false)
    expect(scheduleDue(S({ every: 60 }), at(0, 0))).toBe(true)
  })

  it('describes itself in words', () => {
    expect(describeSchedule(S({ at: ['09:00', '17:30'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] }))).toBe('at 09:00 and 17:30 on weekdays')
    expect(describeSchedule(S({ every: 30, from: '09:00', until: '18:00' }))).toBe('every 30 minutes from 09:00 to 18:00')
    expect(describeSchedule(S({ every: 120, days: ['sat', 'sun'] }))).toBe('every 2 hours at weekends')
    expect(describeSchedule(S({ at: ['8:00'], days: ['mon', 'wed'] }))).toBe('at 08:00 on Mon and Wed')
    expect(describeSchedule(S({}))).toBe('no time set')
  })

  it('finds the next runs', () => {
    const from = new Date(2026, 10, 27, 17, 45) // a Friday
    const runs = nextRuns(S({ at: ['09:00', '17:30'], days: ['mon', 'tue', 'wed', 'thu', 'fri'] }), from, 2)
    expect(runs.map((d) => [d.getDay(), d.getHours(), d.getMinutes()])).toEqual([[1, 9, 0], [1, 17, 30]])
  })
})
