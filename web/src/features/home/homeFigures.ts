/**
 * The small judgments Home's figures and limit rows make, as pure functions:
 * how a window's spend splits into charged and not charged, how bad a failure
 * rate is, when a limit resets, and when a key stops working.
 */

import type { Severity } from "@/design-system/metrics/SeverityMark"
import { judgeFailures } from "@/features/home/attention"
import {
  calendarDaysUntil,
  DAY_MS,
  EXPIRY_WARN_DAYS,
} from "@/features/home/days"
import { formatRelative } from "@/shared/helpers/format"

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
 * How bad a window's failure rate is, by the thresholds Needs attention uses
 * (`judgeFailures`): Healthy, Elevated, or High.
 */
export function failureSeverity(failed: number, requests: number): Severity {
  const { level } = judgeFailures(failed, requests)
  return level === "high"
    ? { status: "alert", word: "High" }
    : level === "elevated"
      ? { status: "warn", word: "Elevated" }
      : { status: "ok", word: "Healthy" }
}

const DAY_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
})
const TIME_LABEL = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
})

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
