import { buttonVariants } from "@heroui/react"
import { Link } from "@tanstack/react-router"
import { FiPlus } from "react-icons/fi"
import type { OverviewLimits } from "@/client"
import type { UsageScopeKey } from "@/features/usage/usageQuery"
import { LimitRow } from "./LimitRow"

// Navigation that looks like a button is a link.
const LINK_BUTTON = buttonVariants({ size: "sm", variant: "ghost" })

/**
 * What limits spend in this scope, each against its limit: the reader's keys
 * at You, the workspace's keys at Workspace, the organization's workspaces
 * against their ceilings across it. Then the way to make more or manage them.
 */
export function LimitsPanel({
  scope,
  limits,
  isLoading,
  isError,
  inMonth,
  isPast,
  now,
  workspaceId,
  isHidingKeys = false,
}: {
  scope: UsageScopeKey
  limits: OverviewLimits | undefined
  isLoading: boolean
  /** The read failed with nothing to show from before; the banner says why. */
  isError: boolean
  /** "this month", "in September". */
  inMonth: string
  /** The month read has ended, so its limits are today's. */
  isPast: boolean
  now: number
  /** The workspace on screen, marked in a list of workspaces. */
  workspaceId: string | undefined
  /**
   * A member reading the workspace's totals, whose keys are other people's:
   * the server lists none, and the panel says where theirs are instead.
   */
  isHidingKeys?: boolean
}) {
  if (isHidingKeys) {
    return (
      <div className="flex min-w-0 flex-col">
        <h2 className="text-title">Keys</h2>
        <p className="mt-2 border-t border-border-subtle py-3 text-caption">
          Other members&rsquo; keys aren&rsquo;t shown to members. Switch to{" "}
          <strong className="font-semibold text-foreground">You</strong> for
          your own keys and their limits.
        </p>
      </div>
    )
  }
  // What the rows are is the answer's own word, so the title cannot name
  // something other than the rows under it.
  const isWorkspaces = limits
    ? limits.kind === "workspaces"
    : scope === "organization"
  const title = isWorkspaces
    ? "Workspaces"
    : scope === "you"
      ? "Your keys"
      : "Keys"
  const rows = limits?.rows ?? []
  const anyCeiling = rows.some((row) => row.limit !== null)
  const caption = isWorkspaces
    ? `Billed spend ${inMonth}${anyCeiling ? (isPast ? " with each ceiling today" : " against each ceiling") : ""}.`
    : scope === "you"
      ? `Billed spend ${inMonth} ${isPast ? "with each key's limit today" : "against each key's limit"}.`
      : `Top keys by billed spend ${inMonth}.`

  return (
    <div className="flex min-w-0 flex-col">
      <h2 className="text-title">{title}</h2>
      <span className="mb-2 text-caption text-subtle">{caption}</span>
      {isLoading ? (
        <p className="border-t border-border-subtle py-3 text-caption">
          Loading…
        </p>
      ) : isError ? (
        <p className="border-t border-border-subtle py-3 text-caption">
          {isWorkspaces ? "Workspaces" : "Keys"} could not be loaded.
        </p>
      ) : rows.length === 0 ? (
        <p className="border-t border-border-subtle py-3 text-caption">
          {isWorkspaces ? "No workspaces yet." : "No keys yet."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((row) => (
            <LimitRow
              key={row.id}
              row={row}
              now={now}
              isCurrent={isWorkspaces && row.id === workspaceId}
              isPast={isPast}
              neverUsed={isWorkspaces ? `No requests ${inMonth}` : "Never used"}
              marksMine={scope === "workspace"}
              noLimit={isWorkspaces ? "No spend ceiling" : "No limit"}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
        {isWorkspaces ? (
          <Link to="/budgets" className={LINK_BUTTON}>
            Manage budgets
          </Link>
        ) : (
          <Link to="/keys" className={LINK_BUTTON}>
            <FiPlus aria-hidden className="size-3.5" />
            Create key
          </Link>
        )}
        {scope === "you" ? null : (
          <Link
            to={isWorkspaces ? "/workspaces" : "/keys"}
            className={LINK_BUTTON}
          >
            {isWorkspaces ? "All workspaces" : "All keys"}
          </Link>
        )}
      </div>
    </div>
  )
}
