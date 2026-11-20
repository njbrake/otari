import { describe, expect, it } from "vitest"

import { entry } from "@/tests/activity"
import {
  budgetChip,
  cacheHitFraction,
  describeBudget,
  describeChannel,
  describeFailure,
  describeRequested,
  opensInPlayground,
  pricingRefusal,
  tokenSegments,
} from "./requestPanelModel"

const NO_PRICE =
  "No pricing is configured for model 'openai:gpt-4o', and require_pricing is on, so it cannot be billed."

describe("pricingRefusal", () => {
  it("tells the gateway's refusals from a provider's own 402", () => {
    expect(pricingRefusal({ status_code: 402, error_message: NO_PRICE })).toBe(
      "model",
    )
    expect(
      pricingRefusal({
        status_code: 402,
        error_message:
          "Model 'x' is priced per second, which this request cannot be billed on, and require_pricing is on",
      }),
    ).toBe("model")
    expect(
      pricingRefusal({
        status_code: 402,
        error_message: "Tool web_search has no price and require_pricing is on",
      }),
    ).toBe("tool")
    expect(
      pricingRefusal({
        status_code: 402,
        error_message: "Your credit balance is too low",
      }),
    ).toBeNull()
    expect(
      pricingRefusal({ status_code: 400, error_message: NO_PRICE }),
    ).toBeNull()
  })
})

describe("describeFailure", () => {
  it("reads the status, and names a prompt that did not fit", () => {
    expect(describeFailure(entry({ status_code: 429 }))).toBe("Rate limited")
    expect(
      describeFailure(
        entry({ status_code: 400, error_message: "context length exceeded" }),
      ),
    ).toBe("Context too long")
    expect(describeFailure(entry({ status_code: 418 }))).toBe("Failed")
  })
})

describe("describeRequested", () => {
  it("names a policy, a model and an alias", () => {
    expect(
      describeRequested(entry({ requested_model: "p", policy_name: "p" })),
    ).toBe("routing policy")
    expect(describeRequested(entry({ requested_model: "gpt-4o" }))).toBe(
      "model",
    )
    expect(describeRequested(entry({ requested_model: "openai:gpt-4o" }))).toBe(
      "model",
    )
    expect(describeRequested(entry({ requested_model: "smart" }))).toBe(
      "alias → openai:gpt-4o",
    )
    expect(describeRequested(entry({ requested_model: null }))).toBeNull()
  })
})

describe("the channel and budget readings", () => {
  it("reads an imported row as its source's subscription", () => {
    const row = entry({ source: "codex", counts_toward_budget: false })
    expect(describeChannel(row)).toBe("Codex subscription")
    expect(budgetChip(row)).toBe("Subscription")
    expect(describeBudget(row)).toMatch(/Subscription usage/)
  })

  it("reads a gateway row by its key", () => {
    expect(describeChannel(entry())).toBe("API")
    expect(describeChannel(entry({ api_key_id: null }))).toBe(
      "Playground or master key",
    )
    expect(budgetChip(entry())).toBeNull()
    expect(budgetChip(entry({ counts_toward_budget: false }))).toBe(
      "Budget-exempt",
    )
    expect(
      budgetChip(entry({ status: "absorbed", counts_toward_budget: false })),
    ).toBeNull()
    expect(describeBudget(entry({ cost: null }))).toMatch(/Nothing counted/)
    expect(describeBudget(entry())).toBe("Counts toward budgets.")
  })
})

describe("token segments", () => {
  it("leaves out empty buckets and reads the cache share of input", () => {
    const composition = {
      fresh: 100,
      cacheRead: 300,
      cacheWrite: 0,
      output: 50,
      total: 450,
    }
    expect(tokenSegments(composition).map((segment) => segment.key)).toEqual([
      "fresh",
      "cacheRead",
      "output",
    ])
    expect(cacheHitFraction(composition)).toBe(0.75)
    expect(
      cacheHitFraction({ ...composition, fresh: 0, cacheRead: 0, total: 50 }),
    ).toBe(0)
  })
})

describe("opensInPlayground", () => {
  it("offers a gateway chat request and nothing the picker cannot name", () => {
    expect(opensInPlayground(entry())).toBe(true)
    expect(opensInPlayground(entry({ endpoint: "/v1/messages" }))).toBe(true)
    expect(opensInPlayground(entry({ endpoint: "/v1/embeddings" }))).toBe(false)
    expect(opensInPlayground(entry({ source: "claude_code" }))).toBe(false)
  })
})
