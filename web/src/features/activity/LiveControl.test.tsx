import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { InFlightResponse } from "@/client"
import { mockApi, renderPage } from "@/tests/activity"
import { flushRouter } from "@/tests/router"
import { LiveControl } from "./LiveControl"

afterEach(() => {
  vi.restoreAllMocks()
})

const RUNNING: InFlightResponse = {
  total: 3,
  requests: [
    {
      id: "r1",
      model: "claude-opus-5-5",
      user_id: "jordan",
      policy_name: "opus-fallback",
      elapsed_ms: 41_000,
    },
  ],
} as InFlightResponse

describe("LiveControl", () => {
  it("is a plain switch for anyone who does not operate the deployment", async () => {
    const user = userEvent.setup()
    const onLive = vi.fn()
    mockApi()
    renderPage(
      <LiveControl
        isLive
        onLive={onLive}
        inFlight={undefined}
        inFlightUpdatedAt={0}
      />,
    )
    await flushRouter()
    const button = screen.getByRole("button", { name: "Live updates" })
    expect(button).toHaveTextContent("Live")
    expect(button).toHaveAttribute("aria-pressed", "true")
    await user.click(button)
    expect(onLive).toHaveBeenCalledWith(false)
  })

  it("tells an operator what is running, gateway-wide, and says what it left out", async () => {
    const user = userEvent.setup()
    mockApi()
    renderPage(
      <LiveControl
        isLive={false}
        onLive={vi.fn()}
        inFlight={RUNNING}
        inFlightUpdatedAt={Date.now()}
      />,
    )
    await flushRouter()
    await user.click(
      screen.getByRole("button", { name: "Paused, 3 in flight" }),
    )
    expect(screen.getByText("claude-opus-5-5")).toBeInTheDocument()
    expect(screen.getByText(/opus-fallback/)).toBeInTheDocument()
    expect(
      screen.getByText("2 further requests are in flight beyond the 1 listed."),
    ).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Live updates" }),
    ).toHaveAttribute("aria-checked", "false")
  })
})
