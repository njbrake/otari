import { render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { KeyRouting } from "@/client"

import {
  KeyModelsCell,
  KeyMostUsedCell,
  KeyRoutingSummary,
} from "@/features/keys/KeyRoutingCells"
import { renderWithRouter } from "@/tests/router"

const LONG = ["thymeline-anthropic", "fireworks", "another-very-long-instance"]

describe("KeyModelsCell", () => {
  it("is one button that ends in an ellipsis rather than growing past its column", () => {
    const onOpen = vi.fn()
    render(
      <KeyModelsCell
        summary={{
          kind: "selected",
          providers: LONG,
          counts: new Map([["fireworks", 4]]),
          total: 12,
        }}
        onOpen={onOpen}
      />,
    )

    // One control, not a button inside a wrapper that also reports as one: the
    // wrapper sized to its text, so nothing capped it to the column.
    const [button] = screen.getAllByRole("button")
    expect(screen.getAllByRole("button")).toHaveLength(1)
    expect(button).toHaveTextContent(LONG.join(", "))
    expect(button).toHaveClass("block", "max-w-full", "truncate")
    // The tooltip, with the whole list, is anchored on it.
    expect(button).toHaveAttribute("data-slot", "tooltip-trigger")
    button.click()
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

describe("KeyMostUsedCell", () => {
  it("keeps the whole name on hover when the column cuts it short", () => {
    const routing = {
      api_key_id: "k",
      model_count: 3,
      no_backup_count: 0,
      no_backup: [],
      policies: [],
      models: [
        {
          name: "a-very-long-routing-policy-name-for-production",
          requests: 10,
          kind: "policy",
          backup: "has_backup",
          reason: null,
          provider: null,
        },
      ],
    } as KeyRouting
    render(<KeyMostUsedCell routing={routing} />)

    const name = screen.getByText(
      "a-very-long-routing-policy-name-for-production",
    )
    expect(name).toHaveClass("truncate")
    expect(name).toHaveAttribute(
      "title",
      "a-very-long-routing-policy-name-for-production and 2 more",
    )
  })
})

describe("KeyRoutingSummary", () => {
  const pinned = {
    name: "openai:gpt-5",
    requests: 40,
    kind: "pinned",
    backup: "no_backup",
    reason: "pinned",
    provider: "openai",
  } as const
  const single = {
    name: "google/gemini-x",
    requests: 3,
    kind: "catalog",
    backup: "no_backup",
    reason: "single_offering",
    provider: "gemini",
  } as const
  const routing: KeyRouting = {
    api_key_id: "k",
    model_count: 14,
    no_backup_count: 5,
    policies: [
      { name: "coding", requests: 1200, deleted: false },
      { name: "old-coding", requests: 9, deleted: true },
    ],
    models: [
      {
        name: "coding",
        requests: 1200,
        kind: "policy",
        backup: "has_backup",
        reason: null,
        provider: null,
      },
    ],
    // Drawn from every name, the ones past the top ten included.
    no_backup: [
      pinned,
      single,
      { ...single, name: "a", requests: 2 },
      { ...single, name: "b", requests: 1 },
      { ...single, name: "c", requests: 1 },
    ],
  }

  it("lists the names with no backup and why, and says how many more", async () => {
    await renderWithRouter(
      <KeyRoutingSummary routing={routing} isPending={false} />,
    )

    expect(
      screen.getByText("coding (1,200), old-coding (9, since deleted)"),
    ).toBeInTheDocument()
    expect(screen.getByText("5 of 14 models have none")).toBeInTheDocument()
    const missing = screen.getByRole("list", { name: "Names with no backup" })
    expect(within(missing).getAllByRole("listitem")).toHaveLength(3)
    expect(missing).toHaveTextContent("openai:gpt-5 · pinned to openai")
    expect(missing).toHaveTextContent("google/gemini-x · only gemini serves it")
    expect(screen.getByText("and 2 more without a backup")).toBeInTheDocument()
    // The most-used name is a policy, so the link opens Routing on no target.
    expect(
      screen.getByRole("link", { name: "Set up routing" }),
    ).toHaveAttribute("href", "/routing")
  })

  it("says so when the read failed rather than claiming nothing was sent", () => {
    render(<KeyRoutingSummary routing={undefined} isPending={false} />)
    expect(
      screen.getByText("What this key sent could not be read."),
    ).toBeInTheDocument()
  })
})
