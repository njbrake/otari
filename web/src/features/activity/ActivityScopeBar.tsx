import type { ReactNode } from "react"
import type { WorkspaceSpend } from "@/client"
import { Segmented } from "@/design-system/navigation/Segmented"
import { formatUtcMinute } from "@/shared/helpers/format"
import { ACTIVITY_PRESETS } from "@/shared/helpers/timeRange"
import { ScopeSwitch } from "./ScopeSwitch"
import { WorkspaceBudget } from "./WorkspaceBudget"

const WINDOWS = ACTIVITY_PRESETS.map((preset) => ({
  value: preset.key,
  label: preset.label,
}))

/**
 * Whose requests, over which window, and what the workspace has spent against
 * its ceiling.
 */
export function ActivityScopeBar({
  isManager,
  canNarrowToOwn,
  scope,
  onScope,
  range,
  onRange,
  bounds,
  now,
  spend,
  trailing,
}: {
  isManager: boolean
  canNarrowToOwn: boolean
  scope: "workspace" | "you"
  onScope: (scope: "workspace" | "you") => void
  range: string
  onRange: (range: string) => void
  /** The list's window, for the caption. */
  bounds: { start?: string; end?: string }
  /** Where a window with no end stops. */
  now: number
  spend: WorkspaceSpend | undefined
  trailing?: ReactNode
}) {
  // A manager whose own requests cannot be told apart has no switch, and so
  // nothing for the rule to separate.
  const hasScope = !isManager || canNarrowToOwn
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border py-3">
      {hasScope ? (
        <>
          <ScopeSwitch
            isManager={isManager}
            canNarrowToOwn={canNarrowToOwn}
            scope={scope}
            onScope={onScope}
            ownLabel="Your requests"
          />
          <span aria-hidden className="h-5 w-px bg-border" />
        </>
      ) : null}
      <Segmented
        label="Window"
        value={range}
        onChange={onRange}
        options={WINDOWS}
      />
      <span className="text-caption">
        {bounds.start
          ? `${formatUtcMinute(bounds.start)} – ${formatUtcMinute(
              bounds.end ?? now,
            )} UTC`
          : "All time"}
      </span>
      <span className="ml-auto">
        <WorkspaceBudget spend={spend} />
      </span>
      {trailing}
    </div>
  )
}
