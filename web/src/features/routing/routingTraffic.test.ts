import { describe, expect, it } from "vitest"

import type { NameTraffic } from "@/client"

import type { RoutingRow } from "./policyModel"
import { namesSent, trafficForRow } from "./routingTraffic"

const WS = "11111111-1111-1111-1111-111111111111"
const OTHER_WS = "22222222-2222-2222-2222-222222222222"
const SAM = "33333333-3333-3333-3333-333333333333"
const PRIYA = "44444444-4444-4444-4444-444444444444"

function row(overrides: Partial<RoutingRow>): RoutingRow {
  return {
    name: "fast",
    spec: { select: [{ default: "openai:gpt-5" }] },
    source: "stored",
    user_id: null,
    workspace_id: WS,
    is_dynamic: false,
    created_at: null,
    updated_at: null,
    kind: "policy",
    ...overrides,
  } as RoutingRow
}

function traffic(
  user: string | null,
  key: string,
  requests: number,
  workspace = WS,
): NameTraffic {
  return {
    workspace_id: workspace,
    name: "fast",
    user_id: user,
    requests,
    sent_by: [{ api_key_id: key, requests }],
    steps: [],
  }
}

describe("trafficForRow", () => {
  const shared = row({})
  const samsOwn = row({ user_id: SAM })
  const rows = [shared, samsOwn]
  const all = [
    traffic(SAM, "sam-key", 5),
    traffic(PRIYA, "priya-key", 3),
    traffic(PRIYA, "priya-key", 2, OTHER_WS),
  ]

  it("gives a member's own row that member's requests alone", () => {
    expect(trafficForRow(samsOwn, rows, all)).toEqual({
      requests: 5,
      sentBy: [{ apiKeyId: "sam-key", requests: 5 }],
    })
  })

  it("gives the shared row everyone else's in its workspace", () => {
    expect(trafficForRow(shared, rows, all)).toEqual({
      requests: 3,
      sentBy: [{ apiKeyId: "priya-key", requests: 3 }],
    })
  })

  it("gives a config-file row the traffic of every workspace", () => {
    const config = row({ source: "config", workspace_id: null })
    expect(trafficForRow(config, [config], all).requests).toBe(10)
  })

  it("lists the names a filter left traffic under", () => {
    expect(
      namesSent([
        traffic(SAM, "k", 1),
        { ...traffic(SAM, "k", 0), name: "idle" },
      ]),
    ).toEqual(new Set(["fast"]))
  })
})
