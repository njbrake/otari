import { describe, expect, it } from "vitest"

import type { NameTraffic } from "@/client"
import type { RoutingRow } from "@/features/routing/policyModel"
import { namesSent, trafficForRow } from "@/features/routing/routingTraffic"

const row = (overrides: Partial<RoutingRow> = {}): RoutingRow => ({
  name: "fast",
  spec: { select: [{ default: "openai:gpt-5" }] },
  source: "stored",
  user_id: null,
  is_dynamic: false,
  created_at: null,
  updated_at: null,
  kind: "policy",
  workspace_id: "w1",
  ...overrides,
})

const TRAFFIC: NameTraffic[] = [
  {
    workspace_id: "w1",
    name: "fast",
    requests: 10,
    sent_by: [{ api_key_id: "a", key_name: "a", requests: 10 }],
    steps: [
      {
        target: "openai:gpt-5",
        role: "default",
        router: null,
        position: 1,
        served: 10,
        failed: 2,
      },
    ],
  },
  {
    workspace_id: "w2",
    name: "fast",
    requests: 5,
    sent_by: [{ api_key_id: "b", key_name: "b", requests: 5 }],
    steps: [
      {
        target: "openai:gpt-5",
        role: "default",
        router: null,
        position: 1,
        served: 5,
        failed: 0,
      },
      {
        target: "anthropic:claude-x",
        role: "on_failure",
        router: null,
        position: 1,
        served: 1,
        failed: 0,
      },
    ],
  },
  {
    workspace_id: "w1",
    name: "slow",
    requests: 0,
    sent_by: [],
    steps: [],
  },
]

describe("trafficForRow", () => {
  it("takes a stored row's own workspace's traffic alone", () => {
    const traffic = trafficForRow(row(), TRAFFIC)
    expect(traffic.requests).toBe(10)
    expect(traffic.sentBy.map((key) => key.api_key_id)).toEqual(["a"])
    expect(traffic.steps).toEqual([
      {
        target: "openai:gpt-5",
        role: "default",
        router: null,
        position: 1,
        served: 10,
        failed: 2,
      },
    ])
  })

  it("takes every workspace's for a config-file row, busiest key first", () => {
    const traffic = trafficForRow(
      row({ source: "config", workspace_id: undefined }),
      TRAFFIC,
    )
    expect(traffic.requests).toBe(15)
    expect(traffic.sentBy.map((key) => key.api_key_id)).toEqual(["a", "b"])
    // One row per target and role, the default summed across workspaces, and
    // a backup that ran first (its default dropped) after it within place 1.
    expect(
      traffic.steps.map((step) => [
        step.target,
        step.role,
        step.served,
        step.failed,
      ]),
    ).toEqual([
      ["openai:gpt-5", "default", 15, 2],
      ["anthropic:claude-x", "on_failure", 1, 0],
    ])
  })

  it("gives an alias the traffic sent under its name, like a policy", () => {
    const traffic = trafficForRow(row({ kind: "alias" }), TRAFFIC)
    expect(traffic.requests).toBe(10)
    expect(traffic.sentBy.map((key) => key.api_key_id)).toEqual(["a"])
  })
})

describe("namesSent", () => {
  it("keeps the names any request was sent under", () => {
    expect(namesSent(TRAFFIC)).toEqual(new Set(["fast"]))
  })
})
