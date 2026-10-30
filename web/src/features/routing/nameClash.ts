import type { RoutingRow } from "./policyModel"

/** Who a new policy is for: the workspace, or one person by their identity id. */
export type NewPolicyScope =
  | { kind: "workspace" }
  | { kind: "person"; userId: string; isCaller: boolean }

/**
 * Why a new policy cannot take `name` among the rows already in force, or "".
 *
 * An alias and a policy cannot share a name, since both would claim it. A
 * workspace-wide policy cannot shadow a deployment one, which wins for the
 * workspace anyway, nor another workspace-wide one. A person's own policy may
 * share a shared policy's name, which is how it replaces it for them, but not
 * one they already have.
 */
export function nameClash(
  name: string,
  rows: readonly RoutingRow[],
  scope: NewPolicyScope,
): string {
  const wanted = name.trim()
  if (wanted === "") return ""
  // The new-policy page's own address, so a policy of that name could never be opened.
  if (wanted === "new") return `"new" is reserved here. Pick another name.`
  const same = rows.filter((row) => row.name === wanted)
  if (same.some((row) => row.kind === "alias"))
    return `${wanted} is an alias. Pick another name.`
  if (scope.kind === "workspace") {
    if (same.some((row) => row.source === "config" && !row.user_id))
      return `A deployment policy is already called "${wanted}". Pick another name.`
    if (same.some((row) => !row.user_id))
      return `This workspace already has a policy called "${wanted}". Open it to change it, or pick another name.`
    return ""
  }
  if (same.some((row) => row.user_id === scope.userId))
    return scope.isCaller
      ? `You already have a policy called "${wanted}". Open it to change it.`
      : `They already have a policy called "${wanted}". Open it to change it.`
  return ""
}
