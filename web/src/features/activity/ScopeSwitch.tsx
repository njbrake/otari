import { FiUser } from "react-icons/fi"
import { Segmented } from "@/design-system/navigation/Segmented"

/**
 * Whose requests the log shows. Someone who manages the workspace switches
 * between the workspace's and their own; everyone else reads their own, which
 * the server decides, so they are told rather than offered a choice.
 */
export function ScopeSwitch({
  isManager,
  canNarrowToOwn,
  scope,
  onScope,
  ownLabel,
}: {
  isManager: boolean
  /** False for a manager whose own requests cannot be told apart (no member id). */
  canNarrowToOwn: boolean
  scope: "workspace" | "you"
  onScope: (scope: "workspace" | "you") => void
  /** What a member's label says: "Your requests" on the desk, "Yours" on a phone. */
  ownLabel: string
}) {
  if (!isManager) {
    return (
      <span className="flex items-center gap-1.5 text-sm whitespace-nowrap">
        <FiUser aria-hidden className="size-3.5 text-muted" />
        {ownLabel}
      </span>
    )
  }
  if (!canNarrowToOwn) return null
  return (
    <Segmented
      label="Scope"
      value={scope}
      onChange={(next) => onScope(next === "you" ? "you" : "workspace")}
      options={[
        { value: "workspace", label: "Workspace" },
        { value: "you", label: "You" },
      ]}
    />
  )
}
