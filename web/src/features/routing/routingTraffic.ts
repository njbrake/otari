import type { NameTraffic } from "@/client"

import type { RoutingRow } from "./policyModel"

/** How many requests one key sent under a row's name. */
export interface KeyRequests {
  apiKeyId: string
  requests: number
}

/** A row's share of the traffic: how many requests it served, and which keys sent them. */
export interface RowTraffic {
  requests: number
  sentBy: KeyRequests[]
}

/**
 * The traffic one row of the routing list served.
 *
 * A name is logged the same whether a member's own policy or the shared one
 * served it, so the person decides: a member's own row takes that member's
 * requests, and a shared row everyone else's, leaving out whoever has their own
 * version of the name in that workspace (their requests went to it). A stored
 * row takes its own workspace's traffic; a config-file row, which is in force in
 * every workspace, takes any.
 */
export function trafficForRow(
  row: RoutingRow,
  rows: readonly RoutingRow[],
  traffic: readonly NameTraffic[],
): RowTraffic {
  const workspace = row.workspace_id ?? undefined
  const ownVersions = new Set(
    rows
      .filter(
        (other) =>
          other.name === row.name &&
          other.user_id &&
          (workspace === undefined || other.workspace_id === workspace),
      )
      .map((other) => other.user_id as string),
  )
  const entries = traffic.filter(
    (entry) =>
      entry.name === row.name &&
      (workspace === undefined || entry.workspace_id === workspace) &&
      (row.user_id
        ? entry.user_id === row.user_id
        : !(entry.user_id && ownVersions.has(entry.user_id))),
  )
  const keys = new Map<string, number>()
  for (const entry of entries) {
    for (const key of entry.sent_by) {
      keys.set(key.api_key_id, (keys.get(key.api_key_id) ?? 0) + key.requests)
    }
  }
  return {
    requests: entries.reduce((total, entry) => total + entry.requests, 0),
    sentBy: [...keys]
      .map(([apiKeyId, requests]) => ({ apiKeyId, requests }))
      .sort(
        (a, b) =>
          b.requests - a.requests || a.apiKeyId.localeCompare(b.apiKeyId),
      ),
  }
}

/** The names a key filter leaves: those any of the filtered traffic was sent under. */
export function namesSent(traffic: readonly NameTraffic[]): Set<string> {
  return new Set(
    traffic.filter((entry) => entry.requests > 0).map((entry) => entry.name),
  )
}
