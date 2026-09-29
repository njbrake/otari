/**
 * Which lanes the log shows, and how wide each is.
 *
 * One map for both the header widths and the table's minimum width, which is
 * their sum: below it the frame scrolls sideways rather than squeezing Model to
 * nothing. Model has no width of its own, only a floor, and takes what the rest
 * leave.
 */

import type { ColumnKey } from "./activityQuery"

const LANE_REM: Record<ColumnKey, number> = {
  time: 6,
  member: 7.5,
  model: 11.5,
  policy: 10.5,
  source: 14.5,
  tokens: 6.75,
  cost: 7,
  latency: 7.75,
  status: 9,
}

// With a request open beside the log, Model is one of four lanes and gets room.
const COMPACT_MODEL_REM = 17.5

/** A lane's fixed width, or undefined for Model, which takes the rest. */
export function laneWidthRem(column: ColumnKey): number | undefined {
  return column === "model" ? undefined : LANE_REM[column]
}

/**
 * The lanes on screen. Member shows only where the log spans several people,
 * Policy only where some of it was routed; with a request open the rest of the
 * detail is in the panel, so the table narrows to what picks a row out.
 */
export function activityColumns({
  isCompact,
  showsMembers,
  showsPolicies,
}: {
  isCompact: boolean
  showsMembers: boolean
  showsPolicies: boolean
}): ColumnKey[] {
  const member: ColumnKey[] = showsMembers ? ["member"] : []
  if (isCompact) return ["time", ...member, "model", "cost", "status"]
  return [
    "time",
    ...member,
    "model",
    ...(showsPolicies ? (["policy"] as const) : []),
    "source",
    "tokens",
    "cost",
    "latency",
    "status",
  ]
}

/** The sum of the lanes, Model at its floor: the width below which the frame scrolls. */
export function tableMinWidthRem(
  columns: ColumnKey[],
  isCompact: boolean,
): number {
  return columns.reduce(
    (sum, column) =>
      sum +
      (column === "model" && isCompact ? COMPACT_MODEL_REM : LANE_REM[column]),
    0,
  )
}
