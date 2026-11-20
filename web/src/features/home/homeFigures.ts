/**
 * The small judgments Home's figures and limit rows make, as pure functions:
 * how a window's spend splits into charged and not charged, how bad a failure
 * rate is, when a limit resets, and when a key stops working.
 */

import type { Severity } from "@/design-system/metrics/SeverityMark"
import {
  MIN_FAILURE_RATE,
  MIN_FAILURES,
  URGENT_FAILURE_RATE,
} from "@/features/home/attention"
import { formatRelative } from "@/shared/helpers/format"

const DAY_MS = 86_400_000
/** A key this close to its expiry is worth a warning on its row. */
export const EXPIRY_WARN_DAYS = 7

/** Spend under half a cent is rounding, not spend. */
const NOTHING = 0.005

/**
 * A window's spend as the budget sees it: what counted toward a limit, and
 * what did not (imported usage, a budget-exempt key). Undefined where nothing
 * went uncharged or the charged read has not answered, so the figure needs no
 * reconciling line.
 */
export function spendSplit(
  total: number,
  charged: number | undefined,
): { charged: number; notCharged: number } | undefined {
  if (charged === undefined) return undefined
  const notCharged = Math.max(0, total - charged)
  if (notCharged < NOTHING) return undefined
  return { charged: Math.min(charged, total), notCharged }
}

/**
 * How bad a window's failure rate is. Healthy below the attention band's
 * threshold (2%, or fewer than five failures), High at the rate the band calls
 * urgent (10%), Elevated between.
 */
export function failureSeverity(failed: number, requests: number): Severity {
  const rate = requests > 0 ? failed / requests : 0
  if (failed < MIN_FAILURES || rate < MIN_FAILURE_RATE) {
    return { status: "ok", word: "Healthy" }
  }
  return rate >= URGENT_FAILURE_RATE
    ? { status: "alert", word: "High" }
    : { status: "warn", word: "Elevated" }
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
})
const TIME_LABEL = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
})

/** Local midnight of the day `time` falls on. */
function dayOf(time: number): number {
  const date = new Date(time)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Whole local days from `now` to `at`: 0 today, 1 tomorrow. */
function calendarDaysUntil(at: number, now: number): number {
  return Math.round((dayOf(at) - dayOf(now)) / DAY_MS)
}

/**
 * When a limit starts over, as its row says it: "Resets at 3:00 PM" later
 * today, "Resets tomorrow", or "Resets Dec 1". Empty for a limit that never
 * resets, or one whose period has already ended.
 */
export function resetsLabel(periodEnd: string | null, now: number): string {
  if (!periodEnd) return ""
  const at = Date.parse(periodEnd)
  if (Number.isNaN(at) || at <= now) return ""
  const days = calendarDaysUntil(at, now)
  if (days <= 0) return `Resets at ${TIME_LABEL.format(at)}`
  if (days === 1) return "Resets tomorrow"
  return `Resets ${DAY_LABEL.format(at)}`
}

/**
 * A key's expiry, where it is close enough to act on: expired (danger), or
 * expiring within `EXPIRY_WARN_DAYS` (warning). Undefined for a key that does
 * not expire or expires later.
 */
export function expiryNote(
  expiresAt: string | null,
  now: number,
): { text: string; tone: "danger" | "warning" } | undefined {
  if (!expiresAt) return undefined
  const at = Date.parse(expiresAt)
  if (Number.isNaN(at)) return undefined
  if (at <= now) return { text: "Expired", tone: "danger" }
  if (at - now > EXPIRY_WARN_DAYS * DAY_MS) return undefined
  const days = calendarDaysUntil(at, now)
  return {
    text:
      days <= 0
        ? "Expires today"
        : days === 1
          ? "Expires tomorrow"
          : `Expires in ${days} days`,
    tone: "warning",
  }
}

/** When a key last carried a request. */
export function lastUsedLine(lastUsedAt: string | null, now: number): string {
  return lastUsedAt ? `Used ${formatRelative(lastUsedAt, now)}` : "Never used"
}
