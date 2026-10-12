import type { OverviewLimitRow } from "@/client"
import { SpendMeter } from "@/design-system/metrics/SpendMeter"
import {
  formatPct,
  formatRelative,
  formatUsd,
  formatUsdLimit,
  formatUtcDay,
} from "@/shared/helpers/format"
import { BUDGET_WARN } from "./overview"
import { daysUntil, limitFraction } from "./overviewModel"

// Within this many days an expiry is worth a warning.
const EXPIRY_WARN_DAYS = 7

/**
 * One key or workspace against its limit: billed spend this month beside the
 * limit, a meter, and a line of facts (whose, when it was last used, how much
 * of the limit is gone, when it resets or expires). The meter and the share
 * read what the ceiling counts in its own period, which is what the gate
 * enforces, so they can differ from the month's figure. A key only
 * subscription usage is recorded under has no billed spend to meter: it is
 * tracked, not limited.
 */
export function LimitRow({
  row,
  now,
  isCurrent,
  isPast,
  neverUsed,
  marksMine,
  noLimit,
}: {
  row: OverviewLimitRow
  now: number
  /** The workspace on screen, in a list of workspaces. */
  isCurrent: boolean
  /**
   * The month read has ended. A limit is today's, so it is named rather than
   * measured against the month's spend.
   */
  isPast: boolean
  /**
   * What a row with no last use says: a key has never been used; a
   * workspace's last use is its last request in the month read.
   */
  neverUsed: string
  /** Whether to say which rows are the reader's: in a list of everyone's keys. */
  marksMine: boolean
  /** What a row with no limit says: "No limit", "No spend ceiling". */
  noLimit: string
}) {
  const fraction = limitFraction(row)
  const name = row.name ?? (row.is_mine ? "Unnamed key" : "Unnamed")
  const lastUsed = row.last_used_at
    ? `Last used ${formatRelative(row.last_used_at)}`
    : neverUsed
  const isExpired = row.expires_at !== null && Date.parse(row.expires_at) <= now
  const expiresIn =
    row.expires_at !== null ? daysUntil(row.expires_at, now) : undefined
  const facts: { text: string; tone?: "danger" | "warning" }[] = []
  if (!row.is_subscription) {
    if (marksMine && row.is_mine) facts.push({ text: "Yours" })
    facts.push({ text: lastUsed })
    if (row.limit !== null && isPast) {
      facts.push({ text: `Limit today: ${formatUsdLimit(row.limit)}` })
    } else if (row.limit !== null) {
      facts.push({
        text: `${formatPct(fraction, 0)} of limit`,
        // Near and over as the server's attention items judge them.
        tone:
          fraction >= 1
            ? "danger"
            : fraction >= BUDGET_WARN
              ? "warning"
              : undefined,
      })
      if (row.period_end) {
        facts.push({ text: `Resets ${formatUtcDay(row.period_end)}` })
      }
    }
    if (expiresIn !== undefined) {
      facts.push({
        text: isExpired
          ? "Expired"
          : `Expires in ${expiresIn} day${expiresIn === 1 ? "" : "s"}`,
        tone: isExpired
          ? "danger"
          : expiresIn <= EXPIRY_WARN_DAYS
            ? "warning"
            : undefined,
      })
    }
    if (row.limit === null && expiresIn === undefined) {
      facts.push({ text: noLimit })
    }
  }

  return (
    <li className="flex flex-col gap-1.5 border-t border-border-subtle py-3">
      <div className="flex items-baseline gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{name}</span>
          {isCurrent ? (
            <span className="text-caption text-subtle">current</span>
          ) : null}
        </span>
        <span
          className={`shrink-0 text-mono-caption whitespace-nowrap ${
            row.is_subscription ? "text-subtle" : ""
          }`}
        >
          {row.is_subscription ? "—" : formatUsd(row.spent)}
          {row.limit !== null && !isPast ? (
            <span className="text-subtle">
              {" / "}
              {formatUsdLimit(row.limit)}
            </span>
          ) : null}
        </span>
      </div>
      {row.limit !== null && !row.is_subscription && !isPast ? (
        <SpendMeter
          spent={row.limit_spent ?? row.spent}
          allocated={row.limit}
          ariaLabel={`${name} limit used`}
          className="w-full"
        />
      ) : null}
      {row.is_subscription ? (
        <>
          <span className="text-caption text-subtle">{lastUsed}</span>
          <span className="text-caption text-subtle">
            Subscription · tracked, not limited
          </span>
        </>
      ) : (
        <>
          {row.owner_name && !row.is_mine ? (
            <span className="truncate text-caption text-subtle">
              {row.owner_name}
            </span>
          ) : null}
          <span className="flex flex-wrap gap-x-1.5 text-caption text-subtle">
            {facts.map((fact, index) => (
              <span key={fact.text} className="flex gap-x-1.5">
                {index > 0 ? <span aria-hidden>·</span> : null}
                <span
                  className={
                    fact.tone === "danger"
                      ? "text-danger"
                      : fact.tone === "warning"
                        ? "text-warning"
                        : undefined
                  }
                >
                  {fact.text}
                </span>
              </span>
            ))}
          </span>
        </>
      )}
    </li>
  )
}
