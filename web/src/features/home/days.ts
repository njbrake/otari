/** Calendar arithmetic Home's rules and figures share. */

export const DAY_MS = 86_400_000

/** How close a key's expiry is before Home warns about it, in days. */
export const EXPIRY_WARN_DAYS = 7

/** Local midnight of the day `time` falls on. */
function dayOf(time: number): number {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Whole local days from `now` to `at`: 0 today, 1 tomorrow. */
export function calendarDaysUntil(at: number, now: number): number {
  return Math.round((dayOf(at) - dayOf(now)) / DAY_MS)
}
