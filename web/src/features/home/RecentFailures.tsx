import { Link } from "@tanstack/react-router"
import type { UsageEntry } from "@/client"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { Dot } from "@/design-system/indicators/Dot"
import {
  type SpendWindow,
  usageRange,
  windowWords,
} from "@/features/spend/period"
import { useUsageLogs } from "@/shared/api/usage"
import { formatNumber, formatRelative } from "@/shared/helpers/format"

/** Failures listed; the rest are one link away in Requests. */
const SHOWN = 5

/**
 * Where a failed request opens in Requests: the window's failures with that
 * request in the panel. A request is named by its group where it has one, the
 * id a link can open whether or not its row is on the first page.
 */
export function failureSearch(
  entry: Pick<UsageEntry, "id" | "request_group_id">,
  window: SpendWindow,
  userId?: string,
): Record<string, string> {
  return {
    ...usageRange(window),
    status: "error",
    ...(userId ? { user_id: userId } : {}),
    request: entry.request_group_id || entry.id,
  }
}

/**
 * The window's latest failed requests, newest first: when, which model, under
 * which key, and what went wrong. Each row opens that request in Requests.
 */
export function RecentFailures({
  window,
  now,
  workspaceId,
  userId,
  total,
  onOpen,
}: {
  window: SpendWindow
  now: number
  /** The workspace the page shows, or "" for all of them. */
  workspaceId: string
  /** One person's failures, for a member's Home. */
  userId?: string
  /** How many failed in the window, from the page's figures. */
  total: number | undefined
  /** Runs before a row's link opens, to point the shell at the page's workspace. */
  onOpen?: () => void
}) {
  const failures = useUsageLogs(
    {
      ...usageRange(window),
      workspace_id: workspaceId || undefined,
      user_id: userId ? [userId] : undefined,
      status: "error",
    },
    0,
    SHOWN,
    true,
    "organization",
  )
  const rows = failures.data ?? []
  const allSearch = {
    ...usageRange(window),
    status: "error",
    ...(userId ? { user_id: userId } : {}),
  }
  return (
    <section aria-label="Recent failures" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-title">Recent failures</h2>
        {total && total > rows.length ? (
          <Link
            to="/requests"
            search={allSearch}
            onClick={onOpen}
            className="text-sm text-link underline max-sm:inline-flex max-sm:min-h-11 max-sm:items-center"
          >
            See all {formatNumber(total)}
          </Link>
        ) : null}
      </div>
      {failures.isPending && !failures.data ? (
        <ul aria-busy="true" className="flex flex-col border-t border-border">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="border-b border-border-subtle py-3">
              <Skeleton className="h-4 w-[24rem] max-w-full" />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <EmptyMessage>
          {failures.isError
            ? "Could not load"
            : `No request failed ${windowWords(window)}.`}
        </EmptyMessage>
      ) : (
        <ul className="flex flex-col border-t border-border">
          {rows.map((entry) => (
            <li key={entry.id} className="border-b border-border-subtle">
              <Link
                to="/requests"
                search={failureSearch(entry, window, userId)}
                onClick={onOpen}
                aria-label={`Failed request to ${entry.model}, ${formatRelative(entry.timestamp, now)}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 py-2.5 text-sm hover:bg-surface-subtle max-sm:min-h-11 md:grid-cols-[6rem_minmax(0,14rem)_minmax(0,10rem)_minmax(0,1fr)]"
              >
                <span className="text-mono-caption text-muted max-md:order-2 max-md:justify-self-end">
                  {formatRelative(entry.timestamp, now)}
                </span>
                <span className="truncate text-mono-caption text-foreground max-md:order-1">
                  {entry.model}
                </span>
                <span className="truncate text-caption max-md:order-3">
                  {entry.api_key_name || entry.user_alias || "No key"}
                </span>
                <span className="flex min-w-0 items-center gap-2 max-md:order-4 max-md:col-span-2">
                  <Dot className="bg-danger" />
                  {entry.status_code !== null ? (
                    <span className="text-mono-caption text-danger">
                      {entry.status_code}
                    </span>
                  ) : null}
                  <span
                    className="truncate text-caption"
                    title={entry.error_message ?? undefined}
                  >
                    {entry.error_message || "Failed"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
