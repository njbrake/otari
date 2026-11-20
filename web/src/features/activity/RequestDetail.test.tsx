import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { API_ROOT } from "@/shared/api/client"
import { entry, mockApi, renderPage } from "@/tests/activity"
import { flushRouter } from "@/tests/router"
import { RequestDetail } from "./RequestDetail"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("RequestDetail", () => {
  it("shows the stored error verbatim, under a source-neutral heading", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          status: "error",
          status_code: 402,
          error_message: "no pricing configured for openai:gpt-4o",
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("Error (402)")).toBeInTheDocument()
    expect(
      screen.getByText("no pricing configured for openai:gpt-4o"),
    ).toBeInTheDocument()
  })

  it("names where the serving provider keeps data, only when it declared it", async () => {
    mockApi()
    const { unmount } = renderPage(
      <RequestDetail entry={entry({ data_location: "SG" })} />,
    )
    await flushRouter()
    expect(screen.getByText("Data location")).toBeInTheDocument()
    expect(screen.getByText("Singapore")).toBeInTheDocument()
    unmount()

    renderPage(<RequestDetail entry={entry({ data_location: null })} />)
    await flushRouter()
    expect(screen.queryByText("Data location")).toBeNull()
  })

  it("shows the Otari-Request-ID the request was answered under, not the row's own id", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({ id: "row-1", request_group_id: "req-9" })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("req-9")).toBeInTheDocument()
    expect(screen.queryByText("row-1")).toBeNull()
  })

  it("shows a row's own id when it predates request groups", async () => {
    mockApi()
    renderPage(
      <RequestDetail entry={entry({ id: "row-1", request_group_id: null })} />,
    )
    await flushRouter()

    expect(screen.getByText("row-1")).toBeInTheDocument()
  })

  it("names the model and the API key in full, which the row cuts short", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          model: "claude-sonnet-4-5-20250929",
          api_key_id: "key-1",
          api_key_name: "production-backend-service",
        })}
      />,
    )
    await flushRouter()

    const field = (label: string): string =>
      screen.getByText(label, { exact: true }).parentElement!.textContent ?? ""
    expect(field("Model")).toContain("claude-sonnet-4-5-20250929")
    expect(field("API key")).toContain("production-backend-service")
    expect(field("API key ID")).toContain("key-1")
  })

  it("shows a skipped candidate as a note, not as an error", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          status: "absorbed",
          status_code: 429,
          error_message:
            "Skipped: Rate limit 'flash-cap' exceeded: 2 requests per minute",
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("Skipped")).toBeInTheDocument()
    expect(
      screen.getByText(
        /^Rate limit 'flash-cap' exceeded: 2 requests per minute\. Routing moved/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText("Error (429)")).not.toBeInTheDocument()
  })

  it("spells out the billed total beside the provider-reported one", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          prompt_tokens: 400,
          completion_tokens: 200,
          // An additive-convention row: the provider reports the cache buckets
          // outside its own total, so the billed figure is the larger one.
          total_tokens: 600,
          billing_meters: {
            total_input_tokens: 1000,
            cache_read_tokens: 600,
            completion_tokens: 200,
          },
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("Total tokens").parentElement).toHaveTextContent(
      "600",
    )
    expect(screen.getByText("Billed tokens")).toBeInTheDocument()
    expect(
      screen.getByTitle(/the tokens this request was priced on/),
    ).toHaveTextContent("1,200")
  })

  it("shows a named user's whole name, while the copy keeps the id", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          user_id: "81e24d08-7d1e-4287-a074-54aa57d9debc",
          user_alias: "Aleksandra Wiśniewska-Kowalczyk",
        })}
      />,
    )
    await flushRouter()

    // The detail is where a name the row cut short is read in full, so it
    // wraps. jsdom cannot measure truncation, so the wrapping class is pinned.
    expect(screen.getByText("Aleksandra Wiśniewska-Kowalczyk")).toHaveClass(
      "wrap-anywhere",
    )
    expect(
      screen.getByRole("button", { name: "Copy user id" }),
    ).toBeInTheDocument()
  })

  it("shows the reasoning tokens, and a dash for a row that never recorded them", async () => {
    mockApi()
    const { unmount } = renderPage(
      <RequestDetail entry={entry({ reasoning_tokens: 1234 })} />,
    )
    await flushRouter()

    expect(
      screen.getByText("Reasoning tokens").parentElement,
    ).toHaveTextContent("1,234")
    unmount()

    renderPage(<RequestDetail entry={entry()} />)
    await flushRouter()

    expect(
      screen.getByText("Reasoning tokens").parentElement,
    ).toHaveTextContent("—")
  })

  it("shows the path a served request was called on", async () => {
    mockApi()
    renderPage(<RequestDetail entry={entry()} />)
    await flushRouter()

    expect(screen.getByText("Endpoint").parentElement).toHaveTextContent(
      `${API_ROOT}/chat/completions`,
    )
  })

  it("shows an imported row's endpoint as its source reported it", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({ source: "claude_code", endpoint: "/v1/messages" })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("Endpoint").parentElement).toHaveTextContent(
      "/v1/messages",
    )
    expect(screen.getByText("Endpoint").parentElement).not.toHaveTextContent(
      API_ROOT,
    )
  })

  it("names a row's tool calls and what they cost", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          billing_meters: {
            tools: { web_search: { billed: 3, errors: 1, unit_rate: 0.01 } },
          },
        })}
      />,
    )
    await flushRouter()

    const card = screen.getByText("Web search").closest("li")!
    expect(card).toHaveTextContent("×3")
    expect(card).toHaveTextContent("1 failed")
    expect(card).toHaveTextContent(/\$0\.01\d* per call/)
    expect(card).toHaveTextContent("$0.03")
  })

  it("says a tool is unpriced rather than reporting it as free", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          billing_meters: { tools: { web_search: { billed: 3 } } },
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("unpriced")).toBeInTheDocument()
    expect(screen.getByText(/no per-call price is set/)).toBeInTheDocument()
  })

  it("offers to price the model behind an uncosted row, keyed on instance:model", async () => {
    const user = userEvent.setup()
    const onPriceModel = vi.fn()
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({ cost: null, provider: "openai", model: "gpt-4o" })}
        onPriceModel={onPriceModel}
      />,
    )
    await flushRouter()

    await user.click(screen.getByRole("button", { name: "Price this model" }))
    expect(onPriceModel).toHaveBeenCalledWith(
      "openai:gpt-4o",
      "/v1/chat/completions",
    )
  })

  it("passes the endpoint with the model, so a rerank row prices per request", async () => {
    const user = userEvent.setup()
    const onPriceModel = vi.fn()
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          cost: null,
          provider: "cohere",
          model: "rerank-v3.5",
          endpoint: "/v1/rerank",
        })}
        onPriceModel={onPriceModel}
      />,
    )
    await flushRouter()

    await user.click(screen.getByRole("button", { name: "Price this model" }))
    expect(onPriceModel).toHaveBeenCalledWith(
      "cohere:rerank-v3.5",
      "/v1/rerank",
    )
  })

  it("still explains an uncosted row to a caller who cannot price it", async () => {
    // Pricing a model is a deployment-wide write, so offering the button to a
    // tenant would be offering a refusal; the sentence is still theirs to read.
    mockApi()
    renderPage(<RequestDetail entry={entry({ cost: null })} />)
    await flushRouter()

    expect(
      screen.queryByRole("button", { name: "Price this model" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/A deployment operator sets one/),
    ).toBeInTheDocument()
  })

  it.each([
    [404, "The model `gpt-5-nonexistent` does not exist."],
    [402, "Your credit balance is too low to access the API."],
  ])(
    "does not offer a price for a failed attempt (%i), which billed nothing",
    async (statusCode, message) => {
      // Nothing was billed, whatever the cause, so a price is not the fix; the
      // error above names the cause, the gateway's own pricing refusal included.
      mockApi()
      renderPage(
        <RequestDetail
          entry={entry({
            cost: null,
            status: "error",
            status_code: statusCode,
            error_message: message,
          })}
          onPriceModel={vi.fn()}
        />,
      )
      await flushRouter()

      expect(screen.getByText(message)).toBeInTheDocument()
      expect(
        screen.queryByRole("button", { name: "Price this model" }),
      ).not.toBeInTheDocument()
      expect(screen.queryByText(/carries no cost/)).not.toBeInTheDocument()
    },
  )

  it("treats a zero cost as a real price, not as uncosted", async () => {
    mockApi()
    renderPage(
      <RequestDetail entry={entry({ cost: 0 })} onPriceModel={vi.fn()} />,
    )
    await flushRouter()

    expect(
      screen.queryByRole("button", { name: "Price this model" }),
    ).not.toBeInTheDocument()
  })

  it("renders the routing plan only for a routed request", async () => {
    mockApi()
    const { unmount } = renderPage(
      <RequestDetail entry={entry({ policy_name: null })} />,
    )
    await flushRouter()
    expect(screen.queryByText(/Routing plan/)).not.toBeInTheDocument()
    unmount()

    mockApi()
    renderPage(<RequestDetail entry={entry({ policy_name: "cheap-first" })} />)
    await flushRouter()
    expect(await screen.findByText(/Routing plan/)).toBeInTheDocument()
  })

  it("prints a charge line through the rate format its shape carries", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          pricing_breakdown: [
            {
              meter: "web_search",
              units: 2,
              unit_rate: 0.01,
              cost: 0.02,
            },
            {
              meter: "completion_tokens",
              units: 200,
              rate_per_million: 10,
              cost: 0.002,
            },
          ],
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("Billed meters")).toBeInTheDocument()
    expect(screen.getByText(/200 at \$10.00 \/ 1M/)).toBeInTheDocument()
    expect(screen.getByText(/2 at .* each/)).toBeInTheDocument()
  })

  it("shows one line per label for a tool that ran under several", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          pricing_breakdown: [
            {
              meter: "web_fetch_calls",
              label: "builtin:builtin_fetch",
              units: 2,
              unit_rate: 0.01,
              cost: 0.02,
            },
            {
              meter: "web_fetch_calls",
              label: "tabstack:tabstack",
              units: 1,
              unit_rate: 0.005,
              cost: 0.005,
            },
            // A tool line an older gateway stored, without a label.
            {
              meter: "web_search_calls",
              units: 3,
              unit_rate: 0.01,
              cost: 0.03,
            },
          ],
        })}
      />,
    )
    await flushRouter()

    expect(screen.getAllByText("web fetch calls")).toHaveLength(2)
    expect(screen.getByText("builtin:builtin_fetch")).toBeInTheDocument()
    expect(screen.getByText("tabstack:tabstack")).toBeInTheDocument()
    expect(screen.getByText(/2 at .* each/)).toBeInTheDocument()
    expect(screen.getByText(/3 at .* each/)).toBeInTheDocument()
  })

  it("shows the provider-reported compute time alongside Total time", async () => {
    // provider_latency_ms is a diagnostic alongside Total time (otari#337); this
    // asserts the row's value actually reaches the "Provider time" field rather
    // than only being present in the fixture shape.
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({ provider: "groq", provider_latency_ms: 156 })}
      />,
    )
    await flushRouter()

    const label = screen.getByText("Provider time", {
      selector: "span.text-overline",
    })
    expect(label.parentElement?.textContent).toContain("156 ms")
  })

  it("names what the caller asked for beside what served it", async () => {
    mockApi()
    const { unmount } = renderPage(
      <RequestDetail
        entry={entry({
          requested_model: "fast",
          model: "claude-opus-4",
          provider: "anthropic",
        })}
      />,
    )
    await flushRouter()
    expect(screen.getByText("Requested as").parentElement).toHaveTextContent(
      "fast · alias → anthropic:claude-opus-4",
    )
    expect(screen.getByText("Served by").parentElement).toHaveTextContent(
      "anthropic:claude-opus-4",
    )
    unmount()

    renderPage(
      <RequestDetail
        entry={entry({
          requested_model: "cheap-first",
          policy_name: "cheap-first",
        })}
      />,
    )
    await flushRouter()
    expect(screen.getByText("Requested as").parentElement).toHaveTextContent(
      "cheap-first · routing policy",
    )
  })

  it("leaves out the requested name on a row that never recorded one", async () => {
    mockApi()
    renderPage(<RequestDetail entry={entry({ requested_model: null })} />)
    await flushRouter()
    expect(screen.queryByText("Requested as")).not.toBeInTheDocument()
  })

  it("names an imported row's channel, marks it a subscription and its cost an equivalent", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({ source: "claude_code", counts_toward_budget: false })}
      />,
    )
    await flushRouter()
    const channel = screen.getByText("Channel").parentElement!
    expect(channel).toHaveTextContent("Claude Code subscription")
    expect(within(channel).getByText("Subscription")).toBeInTheDocument()
    expect(screen.getByText("Equivalent cost")).toBeInTheDocument()
    expect(screen.queryByText("Billed")).not.toBeInTheDocument()
    expect(screen.getByText("Budget").parentElement).toHaveTextContent(
      "Subscription usage does not count toward budgets",
    )
    expect(screen.getByText("First token").parentElement).toHaveTextContent(
      "Not recorded for imported rows",
    )
  })

  it("marks a gateway row on a budget-exempt key, and one that counts", async () => {
    mockApi()
    const { unmount } = renderPage(
      <RequestDetail entry={entry({ counts_toward_budget: false })} />,
    )
    await flushRouter()
    const channel = screen.getByText("Channel").parentElement!
    expect(channel).toHaveTextContent("API")
    expect(within(channel).getByText("Budget-exempt")).toBeInTheDocument()
    expect(screen.getByText("Budget").parentElement).toHaveTextContent(
      "This key is exempt from budgets",
    )
    unmount()

    renderPage(<RequestDetail entry={entry({ api_key_id: null })} />)
    await flushRouter()
    expect(screen.getByText("Channel").parentElement).toHaveTextContent(
      "Playground or master key",
    )
    expect(screen.getByText("Billed").parentElement).toHaveTextContent(
      "$0.0123",
    )
    expect(screen.getByText("Budget").parentElement).toHaveTextContent(
      "Counts toward budgets",
    )
  })

  it("explains the gateway's require_pricing refusal and offers the price that fixes it", async () => {
    const user = userEvent.setup()
    const onPriceModel = vi.fn()
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          cost: null,
          status: "error",
          status_code: 402,
          error_message:
            "No pricing is configured for model 'openai:gpt-4o', and require_pricing is on, so it cannot be billed.",
        })}
        onPriceModel={onPriceModel}
      />,
    )
    await flushRouter()

    expect(
      screen.getByText("402 Refused: this model has no price"),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/the gateway refused openai:gpt-4o before calling/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Price this model" }))
    expect(onPriceModel).toHaveBeenCalledWith(
      "openai:gpt-4o",
      "/v1/chat/completions",
    )
  })

  it("does not offer a model price for a refused unpriced tool", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          cost: null,
          status: "error",
          status_code: 402,
          error_message:
            "Gateway tool 'web_search' has no pricing, and require_pricing is on.",
        })}
        onPriceModel={vi.fn()}
      />,
    )
    await flushRouter()

    expect(
      screen.getByText("402 Refused: a gateway tool has no price"),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Price this model" }),
    ).not.toBeInTheDocument()
  })

  it("heads a provider failure with its status in words", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          status: "absorbed",
          status_code: 429,
          error_message: "slow down",
          counts_toward_budget: false,
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("429 Rate limited")).toBeInTheDocument()
    expect(
      screen.getByText(/routing moved on to the next candidate/),
    ).toBeInTheDocument()
    // A recovered attempt is outside budgets for a reason of its own.
    expect(screen.queryByText("Budget-exempt")).not.toBeInTheDocument()
  })

  it("draws the token composition and its cache-hit share", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          billing_meters: {
            total_input_tokens: 1000,
            cache_read_tokens: 750,
            completion_tokens: 200,
          },
        })}
      />,
    )
    await flushRouter()

    const bar = screen.getByTestId("token-composition-bar")
    expect(bar.children).toHaveLength(3)
    expect(screen.getByText("75% cache hit")).toBeInTheDocument()
    expect(screen.getByText("Fresh input").parentElement).toHaveTextContent(
      "250",
    )
  })

  it("splits a priced row's cost into model and tools", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({
          cost: 0.05,
          billing_meters: {
            tools: { web_search: { billed: 2, unit_rate: 0.01 } },
          },
        })}
      />,
    )
    await flushRouter()

    expect(screen.getByText("Includes").parentElement).toHaveTextContent(
      "$0.03 model · $0.02 tools",
    )
  })

  it("shows the first-token time a streamed row recorded", async () => {
    mockApi()
    renderPage(<RequestDetail entry={entry({ ttft_ms: 320 })} />)
    await flushRouter()

    expect(screen.getByText("First token").parentElement).toHaveTextContent(
      "320 ms",
    )
  })

  it("leaves the request id to a frame that already shows it", async () => {
    mockApi()
    renderPage(
      <RequestDetail
        entry={entry({ request_group_id: "req-9" })}
        showsRequestId={false}
      />,
    )
    await flushRouter()

    expect(screen.queryByText("Request ID")).not.toBeInTheDocument()
  })
})
