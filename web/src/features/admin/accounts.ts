/**
 * The client half of the two changes the deployment admin API refuses.
 *
 * Both are gates the server already enforces (`DeploymentUserService`), written
 * here so a control that would always be refused is disabled with the reason on
 * it rather than offered and then failed. Neither decides who may do what.
 *
 * Directional, matching the server: only the changes that can lock somebody out
 * are blocked, so granting an account back a flag it lost is still offered on
 * both protected rows.
 */

import type { DeploymentUser } from "@/client"

/**
 * Why deactivating this account, or taking its operator access, is refused.
 *
 * `undefined` when it is allowed. The two reasons are answered by the server on
 * the row itself: nothing else the dashboard fetches names the caller's own
 * identity, and the bootstrap marker is not on any other contract.
 */
export function accountLockoutReason(
  account: DeploymentUser,
): string | undefined {
  // Bootstrap first, and the order matters on the row that is both: the
  // operator reading this page usually *is* the
  // bootstrap identity, and the self reason ends in a remedy ("another operator
  // has to make this change") that no operator can carry out, because the server
  // refuses this change from every one of them. The bootstrap reason is the one
  // that is true of the row whoever is asking.
  if (account.is_bootstrap_operator) {
    return "The bootstrap operator is how master-key sign-in reaches this deployment"
  }
  if (account.is_self) {
    return "This is your own account; another operator has to make this change"
  }
  return undefined
}

/**
 * Why a password link cannot be issued for this account, or `undefined` when it can.
 *
 * The two the row already shows. The gateway refuses more (an account that
 * signs in only with a provider, which the row does not carry), and says why.
 */
export function passwordLinkBlockedReason(
  account: DeploymentUser,
): string | undefined {
  if (!account.is_active) return "Reactivate this account first"
  if (!account.email) return "This account has no email address to sign in with"
  return undefined
}

/**
 * Why this account cannot be handed the bootstrap operator role, or `undefined` when it can.
 *
 * The ones the row shows. The gateway also requires a password and a verified,
 * unblocked address, which the row does not carry, and says so when it refuses.
 */
export function bootstrapHandoverBlockedReason(
  account: DeploymentUser,
): string | undefined {
  if (account.is_bootstrap_operator)
    return "This is already the bootstrap operator"
  if (!account.is_active) return "Reactivate this account first"
  if (!account.is_superuser) return "Make this account an operator first"
  if (!account.email) return "This account has no email address to sign in with"
  return undefined
}

/** How the account is named in a row, a control's label, and a confirmation. */
export function accountLabel(account: DeploymentUser): string {
  return account.full_name?.trim() || account.email || account.id
}

/**
 * One account's organizations, as the row lists them.
 *
 * A suspended membership is kept and marked, where the organization roster drops
 * it: an account whose every membership is suspended is what this page exists to
 * find, and a row saying "no organizations" for one would hide the finding.
 */
export function organizationSummary(account: DeploymentUser): string {
  if (account.organizations.length === 0) return "None"
  return account.organizations
    .map((organization) =>
      organization.status === "active"
        ? `${organization.name} (${organization.role})`
        : `${organization.name} (${organization.role}, ${organization.status})`,
    )
    .join(", ")
}

/** What each table a user merge moves rows in is called in the merge dialog. */
const MERGED_ROWS: Record<string, [one: string, many: string]> = {
  api_keys: ["API key", "API keys"],
  usage_logs: ["Usage row", "Usage rows"],
  agent_telemetry: ["Agent telemetry event", "Agent telemetry events"],
  traces: ["Agent trace", "Agent traces"],
  file_objects: ["File", "Files"],
  batches: ["Batch", "Batches"],
  budget_reservations: [
    "Settled budget reservation",
    "Settled budget reservations",
  ],
  budget_reset_logs: ["Budget reset record", "Budget reset records"],
  model_aliases: ["Personal alias", "Personal aliases"],
  routing_policies: ["Personal routing policy", "Personal routing policies"],
  provider_endpoints: [
    "Personal provider endpoint",
    "Personal provider endpoints",
  ],
  workspace_mcp_server_grants: ["MCP server grant", "MCP server grants"],
  mcp_user_connections: ["MCP connection", "MCP connections"],
  mcp_oauth_flows: ["MCP sign-in in progress", "MCP sign-ins in progress"],
  sandbox_containers: ["Sandbox session", "Sandbox sessions"],
  video_jobs: ["Video job", "Video jobs"],
  idempotency_keys: ["Idempotency record", "Idempotency records"],
  end_users: [
    "End user its service keys bill",
    "End users its service keys bill",
  ],
}

/**
 * The lines a merge preview lists: each kind of row that moves, with how many,
 * most first. A table with nothing to move is left out, and one this build has
 * no words for is named by its table.
 */
export function mergedRowLines(
  moved: Record<string, number>,
): { key: string; count: number; label: string }[] {
  return Object.entries(moved)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => {
      const [one, many] = MERGED_ROWS[key] ?? [key, key]
      return { key, count, label: count === 1 ? one : many }
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * Whether **Merge user record…** is offered for this account: it belongs to the
 * operator's active organization, whose records a merge reaches, and it has a
 * record of its own (`billed`, the user ids that organization's users list
 * holds) to fold another into.
 */
export function canMergeInto(
  account: DeploymentUser,
  activeOrganizationId: string | undefined,
  billed: ReadonlySet<string>,
): boolean {
  return (
    activeOrganizationId !== undefined &&
    account.organizations.some(
      (organization) => organization.organization_id === activeOrganizationId,
    ) &&
    billed.has(account.id)
  )
}
