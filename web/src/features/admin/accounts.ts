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

import type { DeploymentUser, User } from "@/client"

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
  // Bootstrap first, and the order matters on the row that is both: on a
  // standalone deployment the operator reading this page usually *is* the
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

/**
 * Why generating a password for this account is refused.
 *
 * `undefined` when it is allowed. The server refuses the same two, so the
 * control is disabled with the reason rather than offered and then failed.
 */
export function passwordUnavailableReason(
  account: DeploymentUser,
): string | undefined {
  if (account.is_self) {
    return "Change your own password from your account page"
  }
  if (!account.email) {
    return "This account has no email address to sign in with"
  }
  return undefined
}

/**
 * The user records that can be merged into this account's own.
 *
 * Leaves out the account's own record, every other account's (the server refuses
 * to retire a sign-in account's user), and the per-key virtual users.
 */
export function mergeCandidates(
  account: DeploymentUser,
  users: readonly User[],
  accounts: readonly DeploymentUser[],
): User[] {
  const accountIds = new Set(accounts.map((row) => row.id))
  return users.filter(
    (user) =>
      user.user_id !== account.id &&
      !accountIds.has(user.user_id) &&
      !user.user_id.startsWith("apikey-"),
  )
}
