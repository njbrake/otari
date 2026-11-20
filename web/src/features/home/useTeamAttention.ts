import type { UsageSummary } from "@/client"
import {
  type AttentionDay,
  type AttentionInput,
  type AttentionResult,
  attention,
  countedFailures,
} from "@/features/home/attention"
import { useHomeAccount } from "@/features/home/overlayHomeAccount"
import { type LimitTarget, perWords } from "@/features/spend/limits"
import { keyName, memberName } from "@/features/spend/names"
import { toMinute } from "@/features/spend/period"
import type { ReadState, Spend } from "@/features/spend/useSpend"
import { readState } from "@/features/spend/useSpend"
import { useKeys } from "@/shared/api/apiKeys"
import { useAllSpendCeilings } from "@/shared/api/budgets"
import { useDeploymentAdminAccess } from "@/shared/api/deployment"
import { useOrganizationMembers } from "@/shared/api/organizations"
import { useProviderHealth } from "@/shared/api/providers"
import {
  useRefusalsSince,
  useUsageSummary,
  useWorkspaceSummaries,
} from "@/shared/api/usage"
import { useWorkspaces } from "@/shared/api/workspaces"

const DAY_MS = 86_400_000

/** Every read of a set settled, or the worst of them. */
function statesOf(reads: readonly { data: unknown; isError: boolean }[]) {
  const states = reads.map(readState)
  return states.includes("failed")
    ? "failed"
    : states.includes("loading")
      ? "loading"
      : ("ready" satisfies ReadState)
}

/**
 * Reads what the band needs, for the whole organization and the last 24 hours
 * whatever window or workspace the page is showing, and hands it to
 * `attention`. Failures and refusals are read once per workspace, since the
 * Requests page a row opens lists one. Provider reachability is a deployment
 * operator's read, and is left out for anyone else.
 */
export function useTeamAttention(spend: Spend, now: number): AttentionResult {
  const members = useOrganizationMembers()
  const keys = useKeys()
  const workspaces = useWorkspaces()
  const account = useHomeAccount()
  const ceilings = useAllSpendCeilings()
  const access = useDeploymentAdminAccess()
  const isOperator = access.data === true
  const health = useProviderHealth(isOperator)
  const since = new Date(toMinute(now) - DAY_MS).toISOString()
  const workspaceIds = (workspaces.data ?? []).map((one) => one.id)
  const isSplit = workspaceIds.length > 1
  // The organization first, two reads whatever its size. Requests lists one
  // workspace, so a count it would link to is read again workspace by
  // workspace, but only once there is something to link to: failures past a
  // threshold, or any refusal at all.
  const orgDay = useUsageSummary(
    { start_date: since },
    "hour",
    ["status_code"],
    true,
    "organization",
  )
  const orgRefused = useRefusalsSince(since)
  const orgDayFigures = dayOf(orgDay.data)
  const hasFailures = countedFailures(orgDayFigures) !== undefined
  const hasRefusals = (orgRefused.data?.totals.request_count ?? 0) > 0
  const days = useWorkspaceSummaries(
    workspaceIds,
    { start_date: since, bucket: "hour", dimensions: "status_code" },
    isSplit && hasFailures,
  )
  const refused = useWorkspaceSummaries(
    workspaceIds,
    {
      start_date: since,
      status_code: "403",
      bucket: "day",
      dimensions: "user",
    },
    isSplit && hasRefusals,
  )

  const subjects = new Map<string, string>()
  const peopleOf = new Map<string, string[]>()
  const nameByUser = new Map<string, string>()
  for (const member of members.data ?? []) {
    const name = memberName(member)
    const userIds = [member.attribution_user_id, member.user_id].filter(
      (id): id is string => Boolean(id),
    )
    for (const id of userIds) nameByUser.set(id, name)
    if (member.organization_member_id) {
      subjects.set(member.organization_member_id, name)
      peopleOf.set(member.organization_member_id, userIds)
    }
    for (const place of member.workspaces ?? []) {
      subjects.set(
        place.workspace_member_id,
        `${name}, in ${place.workspace_name},`,
      )
      peopleOf.set(place.workspace_member_id, userIds)
    }
  }
  for (const key of keys.data ?? []) {
    subjects.set(
      key.id,
      key.key_name ? `The key ${key.key_name}` : "An unnamed key",
    )
  }
  const workspaceNames = new Map<string, string>()
  for (const workspace of workspaces.data ?? []) {
    subjects.set(workspace.id, `The ${workspace.name} workspace`)
    workspaceNames.set(workspace.id, workspace.name)
  }

  // The row a ceiling sits on, which is what its dialog edits.
  const targets = new Map<string, LimitTarget>()
  for (const row of [...spend.people, ...spend.keys]) {
    const own = row.limits.own
    if (row.target && own) targets.set(own.ceiling.id, row.target)
  }
  const organization = spend.organization
  if (organization.target && organization.limits.own) {
    targets.set(organization.limits.own.ceiling.id, organization.target)
  }
  const list = ceilings.data ?? []
  for (const ceiling of list) {
    const name = workspaceNames.get(ceiling.scope_id)
    const max = ceiling.max_budget
    if (ceiling.scope_type !== "workspace" || !name || max == null) continue
    targets.set(ceiling.id, {
      scope: "workspace",
      scopeId: ceiling.scope_id,
      name,
      own: {
        ceiling,
        max,
        spent: ceiling.current_spend,
        per: perWords(ceiling),
      },
    })
  }

  const states: AttentionInput["states"] = {
    limits:
      readState(ceilings) === "ready" &&
      (members.isLoading || keys.isLoading || workspaces.isLoading)
        ? "loading"
        : readState(ceilings),
    refusals:
      workspaces.data === undefined
        ? readState(workspaces)
        : isSplit && hasRefusals
          ? statesOf(refused)
          : readState(orgRefused),
    failures:
      workspaces.data === undefined
        ? readState(workspaces)
        : isSplit && hasFailures
          ? statesOf(days)
          : readState(orgDay),
    keys: readState(keys),
    // Not asked of anyone but the operator, which is an answer, not a wait.
    providers: isOperator
      ? readState(health)
      : access.isPending
        ? "loading"
        : "ready",
    account: account.state,
  }

  return attention({
    now,
    states,
    ceilings: list,
    subjects,
    workspaceNames,
    targets,
    peopleOf,
    account,
    orgDay: orgDayFigures,
    days: isSplit
      ? hasFailures
        ? workspaceIds.map((workspaceId, index) => ({
            workspaceId,
            ...dayOf(days[index]?.data),
          }))
        : []
      : workspaceIds.map((workspaceId) => ({ workspaceId, ...orgDayFigures })),
    refusals: (isSplit
      ? hasRefusals
        ? workspaceIds.map((workspaceId, index) => ({
            workspaceId,
            rows: refused[index]?.data?.by_user ?? [],
          }))
        : []
      : workspaceIds.map((workspaceId) => ({
          workspaceId,
          rows: orgRefused.data?.by_user ?? [],
        }))
    ).flatMap(({ workspaceId, rows }) =>
      rows.map((row) => ({
        workspaceId,
        userId: row.is_other ? null : row.key,
        name:
          (row.key ? nameByUser.get(row.key) : undefined) ||
          row.label ||
          "Someone",
        requests: row.requests,
      })),
    ),
    keys: (keys.data ?? []).map((key) => ({
      id: key.id,
      name: keyName(key),
      workspaceId: key.workspace_id,
      expiresAt: key.expires_at,
      lastUsedAt: key.last_used_at,
      isActive: key.is_active,
    })),
    checksProviders: isOperator,
    unreachable: isOperator
      ? (health.data?.providers ?? [])
          .filter((one) => !one.ok && !one.discovery_unsupported)
          .map((one) => ({ name: one.instance, error: one.error ?? "" }))
      : [],
  })
}

/** A summary's day as the rules read it. */
function dayOf(summary: UsageSummary | undefined): AttentionDay {
  return {
    requests: summary?.totals.request_count ?? 0,
    errors: (summary?.errors_by_status_code ?? []).map((row) => ({
      errorClass: row.error_class,
      requests: row.requests,
    })),
  }
}
