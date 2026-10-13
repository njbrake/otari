import { FiUser, FiUsers } from "react-icons/fi"
import type { WorkspaceSpend } from "@/client"
import { RefreshButton } from "@/design-system/actions/RefreshButton"
import { Segmented } from "@/design-system/navigation/Segmented"
import { formatWindowLabel } from "@/shared/helpers/timeRange"
import { UsageBudget } from "./UsageBudget"
import { SCOPE_LABELS, type UsageScopeKey, WINDOWS } from "./usageQuery"

/**
 * Whose usage, over which window, and what the workspace has spent against
 * its ceiling. Someone who manages the workspace switches scope. Anyone with
 * one scope is told which it is rather than offered a choice: a member their
 * own usage, which the server decides, and a manager whose own requests cannot
 * be told apart the workspace's.
 */
export function UsageScopeBar({
  scopes,
  scope,
  isAwaitingScope = false,
  onScope,
  range,
  onRange,
  bounds,
  spend,
  onRefresh,
  isFetching,
  updatedAt,
}: {
  scopes: readonly UsageScopeKey[]
  scope: UsageScopeKey
  /** Whether there is a choice of scope waits on the workspace's answer, so none is shown yet. */
  isAwaitingScope?: boolean
  onScope: (scope: UsageScopeKey) => void
  range: string
  onRange: (range: string) => void
  /** The window the server aggregated over, for the caption. */
  bounds: { start?: string; end?: string }
  spend: WorkspaceSpend | undefined
  onRefresh: () => void
  isFetching: boolean
  updatedAt: number
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border py-3">
      {isAwaitingScope ? (
        // The scope control's footprint, held while the workspace's answer
        // says whether there is a choice, so the row does not shift when it lands.
        <span aria-hidden className="h-11 w-36 md:h-8" />
      ) : scopes.length > 1 ? (
        <Segmented
          label="Scope"
          value={scope}
          onChange={(next) => onScope(next as UsageScopeKey)}
          options={scopes.map((value) => ({
            value,
            label: SCOPE_LABELS[value],
          }))}
        />
      ) : (
        <span className="flex items-center gap-1.5 text-body whitespace-nowrap">
          {scope === "you" ? (
            <FiUser aria-hidden className="size-3.5 text-muted" />
          ) : (
            <FiUsers aria-hidden className="size-3.5 text-muted" />
          )}
          {scope === "you" ? "Your usage" : "Workspace usage"}
        </span>
      )}
      <span aria-hidden className="h-5 w-px bg-border" />
      <Segmented
        label="Window"
        value={range}
        onChange={onRange}
        options={WINDOWS}
      />
      <span className="text-caption">
        {formatWindowLabel(bounds.start, bounds.end)} UTC
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-4">
        <UsageBudget spend={spend} />
        <RefreshButton
          onRefresh={onRefresh}
          isFetching={isFetching}
          updatedAt={updatedAt || undefined}
        />
      </span>
    </div>
  )
}
