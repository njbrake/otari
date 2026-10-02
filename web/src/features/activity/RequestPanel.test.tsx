import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { UsageEntry } from "@/client"
import { entry, mockApi, renderPage } from "@/tests/activity"
import { flushRouter } from "@/tests/router"
import { RequestPanel } from "./RequestPanel"

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderPanel(
  row: UsageEntry,
  props: Partial<ComponentProps<typeof RequestPanel>> = {},
) {
  mockApi()
  const handlers = {
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onClose: vi.fn(),
    onFilter: vi.fn(),
    onPriceModel: vi.fn(),
  }
  renderPage(
    <RequestPanel
      entry={row}
      position="3 / 25"
      memberName={(id) => `Name of ${id}`}
      showsMember
      {...handlers}
      {...props}
    />,
  )
  await flushRouter()
  return handlers
}

describe("RequestPanel", () => {
  it("heads the panel with the model, the request id the caller got, and its place in the list", async () => {
    await renderPanel(entry({ request_id: "otari-req-1", model: "gpt-4o" }))
    expect(screen.getByRole("heading", { name: "gpt-4o" })).toBeInTheDocument()
    expect(screen.getByText("otari-req-1")).toBeInTheDocument()
    expect(screen.getByText("3 / 25")).toBeInTheDocument()
  })

  it("offers the request id to copy, for a support thread or a log search", async () => {
    await renderPanel(entry({ request_id: "otari-req-1" }))
    expect(
      screen.getByRole("button", { name: "Copy request id" }),
    ).toBeInTheDocument()
  })

  it("draws no token composition for a request that reported no usage", async () => {
    await renderPanel(
      entry({
        status: "error",
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        cost: null,
      }),
    )
    expect(
      screen.queryByRole("heading", { name: "Tokens" }),
    ).not.toBeInTheDocument()
  })

  it("steps, closes and filters through its callbacks", async () => {
    const user = userEvent.setup()
    const handlers = await renderPanel(entry({ source_label: "sess-1" }))
    await user.click(screen.getByRole("button", { name: "Next request (↓)" }))
    await user.click(
      screen.getByRole("button", { name: "Previous request (↑)" }),
    )
    await user.click(screen.getByRole("button", { name: "Close (Esc)" }))
    await user.click(screen.getByRole("button", { name: "Session" }))
    expect(handlers.onNext).toHaveBeenCalled()
    expect(handlers.onPrevious).toHaveBeenCalled()
    expect(handlers.onClose).toHaveBeenCalled()
    expect(handlers.onFilter).toHaveBeenCalledWith("session")
  })

  it("shows a failure's code, reason and stored message", async () => {
    await renderPanel(
      entry({
        status: "error",
        status_code: 429,
        error_message: "rate_limit_error: slow down",
      }),
    )
    expect(
      screen.getByText("429 Rate limited: rate_limit_error: slow down"),
    ).toBeInTheDocument()
  })

  it("offers an operator the price of a model that served with none", async () => {
    const user = userEvent.setup()
    const handlers = await renderPanel(
      entry({ cost: null, provider: "fireworks", model: "deepseek" }),
    )
    expect(
      screen.getByText(/so this request carries no cost/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Set model price…" }))
    expect(handlers.onPriceModel).toHaveBeenCalledWith("fireworks:deepseek")
  })

  it("tells anyone else who sets prices, and never says the request cost $0", async () => {
    await renderPanel(entry({ cost: null }), { onPriceModel: undefined })
    expect(
      screen.queryByRole("button", { name: "Set model price…" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText("A deployment operator sets model prices."),
    ).toBeInTheDocument()
    expect(screen.queryByText(/\$0\b/)).not.toBeInTheDocument()
  })

  it("still offers a price for a request the gateway refused for lacking one", async () => {
    await renderPanel(
      entry({
        status: "error",
        status_code: 402,
        cost: null,
        total_tokens: null,
        error_message: "No pricing for model; require_pricing is enabled",
      }),
    )
    expect(
      screen.getByText(/so the gateway refused this request/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Set model price…" }),
    ).toBeInTheDocument()
  })

  it("does not send a provider's own 402 to pricing", async () => {
    await renderPanel(
      entry({
        status: "error",
        status_code: 402,
        cost: null,
        total_tokens: null,
        error_message: "insufficient balance",
      }),
    )
    expect(
      screen.queryByRole("button", { name: "Set model price…" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText("Failed before the provider reported usage."),
    ).toBeInTheDocument()
  })

  it("treats a $0 cost as priced", async () => {
    await renderPanel(entry({ cost: 0 }))
    expect(
      screen.queryByRole("button", { name: "Set model price…" }),
    ).not.toBeInTheDocument()
    expect(screen.getByText("$0.00")).toBeInTheDocument()
  })

  it("reads an imported row as an equivalent cost outside every budget", async () => {
    await renderPanel(
      entry({
        source: "claude_code",
        counts_toward_budget: false,
        cost: 0.42,
        api_key_name: "laptop",
      }),
    )
    expect(screen.getByText("Equivalent cost")).toBeInTheDocument()
    expect(
      screen.getByText(
        "Excluded. Subscription usage doesn't count toward limits.",
      ),
    ).toBeInTheDocument()
    expect(screen.getByText("via key laptop")).toBeInTheDocument()
    expect(
      screen.getByText("Not recorded for imported rows"),
    ).toBeInTheDocument()
  })

  it("says whether the name the caller sent was a policy, a model or an alias", async () => {
    await renderPanel(
      entry({
        requested_model: "fast",
        provider: "anthropic",
        model: "claude-haiku-4-5",
      }),
    )
    expect(
      screen.getByText("· alias → anthropic:claude-haiku-4-5"),
    ).toBeInTheDocument()
  })

  it("prices each gateway tool call and offers to filter to it", async () => {
    const user = userEvent.setup()
    const handlers = await renderPanel(
      entry({
        cost: 0.05,
        billing_meters: {
          tools: { web_search: { billed: 3, errors: 0, unit_rate: 0.01 } },
        },
      }),
    )
    expect(screen.getByText("$0.03")).toBeInTheDocument()
    expect(screen.getByText("$0.02 model · $0.03 tools")).toBeInTheDocument()
    await user.click(
      screen.getByRole("button", { name: "Filter to web search" }),
    )
    expect(handlers.onFilter).toHaveBeenCalledWith("tool")
  })

  it("says so when a tool carries no per-call price", async () => {
    await renderPanel(
      entry({
        billing_meters: { tools: { web_search: { billed: 1, errors: 0 } } },
      }),
    )
    expect(screen.getByText(/no per-call price is set/)).toBeInTheDocument()
  })

  it("reads each charge line by the rate it carries", async () => {
    await renderPanel(
      entry({
        pricing_breakdown: [
          {
            meter: "web_search",
            units: 2,
            unit_rate: 0.01,
            cost: 0.02,
          },
          {
            meter: "input_tokens",
            units: 1000,
            rate_per_million: 3,
            cost: 0.003,
          },
        ],
      }),
    )
    expect(screen.getByText("1,000 at $3.00 / 1M, $0.003")).toBeInTheDocument()
    expect(screen.getByText("2 at $0.01, $0.02")).toBeInTheDocument()
  })

  it("lists every charge line an older gateway wrote with no meter", async () => {
    const errors = vi.spyOn(console, "error")
    await renderPanel(
      entry({
        pricing_breakdown: [
          { cost: 0.5 },
          { cost: 0.25 },
        ] as unknown as UsageEntry["pricing_breakdown"],
      }),
    )
    expect(
      errors.mock.calls.some((call) => String(call[0]).includes("same key")),
    ).toBe(false)
  })
})
