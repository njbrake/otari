import { screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { entry, mockApi, renderPage } from "@/tests/activity"
import { flushRouter } from "@/tests/router"
import { describeEarlierAttempts, RoutingPlan } from "./RoutingPlan"

afterEach(() => {
  vi.restoreAllMocks()
})

const failed = entry({
  id: "a",
  request_group_id: "grp-1",
  policy_name: "cheap-first",
  status: "absorbed",
  status_code: 429,
  attempt_position: 1,
  attempt_count: 2,
  selection_reason: "default",
  model: "gpt-4o-mini",
  cost: null,
})

const served = entry({
  id: "b",
  request_group_id: "grp-1",
  policy_name: "cheap-first",
  status: "success",
  attempt_position: 2,
  attempt_count: 2,
  selection_reason: "on_failure",
  model: "gpt-4o",
  latency_ms: 1_200,
  cost: 0.02,
})

function planTable() {
  return screen.getByRole("table", {
    name: "Routing plan for cheap-first",
  })
}

describe("RoutingPlan", () => {
  it("reassembles the whole plan from the group, in attempt order", async () => {
    mockApi({ groupRows: [served, failed] })
    renderPage(<RoutingPlan entry={failed} />)
    await flushRouter()

    expect(
      await screen.findByText(
        "Served by attempt 2 of 2: openai:gpt-4o, after 1 failed attempt",
      ),
    ).toBeInTheDocument()
    const rows = within(planTable()).getAllByRole("row").slice(1)
    expect(
      rows.map((row) => within(row).getAllByRole("cell")[0].textContent),
    ).toEqual(["1", "2"])
    expect(
      within(rows[0]).getByText("failed 429, fell back"),
    ).toBeInTheDocument()
    expect(within(rows[1]).getByText("served the request")).toBeInTheDocument()
  })

  it("marks which attempt the open row is", async () => {
    mockApi({ groupRows: [served, failed] })
    renderPage(<RoutingPlan entry={failed} />)
    await flushRouter()

    // Await the assembled plan, not the table: the fallback table renders the
    // single row it was handed while the group lookup is still in flight.
    await screen.findByText(
      "Served by attempt 2 of 2: openai:gpt-4o, after 1 failed attempt",
    )
    const rows = within(planTable()).getAllByRole("row").slice(1)
    expect(within(rows[0]).getByText("this row")).toBeInTheDocument()
    expect(within(rows[1]).queryByText("this row")).not.toBeInTheDocument()
  })

  it("cuts a long target short, with the whole of it in the title", async () => {
    const target =
      "ft:gpt-4o-mini-2024-07-18:northwind-industries:customer-support-v12:9f8e7d6c"
    mockApi({ groupRows: [{ ...served, model: target }, failed] })
    renderPage(<RoutingPlan entry={failed} />)
    await flushRouter()

    await screen.findByText(
      `Served by attempt 2 of 2: openai:${target}, after 1 failed attempt`,
    )
    const cell = within(planTable()).getByTitle(`openai:${target}`)
    expect(cell).toHaveClass("truncate")
  })

  it("says the request ended in an error when no candidate served", async () => {
    const terminal = entry({
      ...served,
      id: "b",
      status: "error",
      status_code: 500,
    })
    mockApi({ groupRows: [failed, terminal] })
    renderPage(<RoutingPlan entry={failed} />)
    await flushRouter()

    expect(
      await screen.findByText("No candidate served this request."),
    ).toBeInTheDocument()
  })

  it("narrates the row itself rather than flashing empty while the lookup runs", async () => {
    mockApi({ groupRows: [] })
    renderPage(<RoutingPlan entry={failed} />)
    await flushRouter()

    expect(
      screen.getByText("Loading the rest of this request's attempts…"),
    ).toBeInTheDocument()
    // The row it was given, so the section is never blank.
    expect(
      within(planTable()).getByText("openai:gpt-4o-mini"),
    ).toBeInTheDocument()
  })

  it("says so for a row that carries no group to look up", async () => {
    mockApi()
    renderPage(
      <RoutingPlan entry={entry({ ...failed, request_group_id: null })} />,
    )
    await flushRouter()

    expect(
      screen.getByText(
        "This row carries no request group, so its other attempts cannot be found.",
      ),
    ).toBeInTheDocument()
  })

  it("lists each failed attempt's own error under the table", async () => {
    mockApi({
      groupRows: [served, { ...failed, error_message: "quota exhausted" }],
    })
    renderPage(<RoutingPlan entry={served} />)
    await flushRouter()

    expect(
      await screen.findByText("quota exhausted", { exact: false }),
    ).toHaveTextContent("Attempt 1 (429): quota exhausted")
  })

  it("counts the skipped candidates beside the failed ones", async () => {
    const skipped = entry({
      ...failed,
      id: "s",
      status_code: null,
      error_message: "Skipped: Rate limit 'cap' exceeded",
      attempt_position: 2,
      attempt_count: 3,
    })
    const third = entry({ ...served, attempt_position: 3, attempt_count: 3 })
    mockApi({ groupRows: [failed, skipped, third] })
    renderPage(<RoutingPlan entry={third} />)
    await flushRouter()

    expect(
      await screen.findByText(
        "Served by attempt 3 of 3: openai:gpt-4o, after 1 failed attempt and 1 skipped candidate",
      ),
    ).toBeInTheDocument()
  })
})

describe("describeEarlierAttempts", () => {
  it("names what came before the served attempt, or nothing", () => {
    expect(describeEarlierAttempts(0, 0)).toBe("")
    expect(describeEarlierAttempts(2, 0)).toBe(", after 2 failed attempts")
    expect(describeEarlierAttempts(0, 1)).toBe(", after 1 skipped candidate")
  })
})
