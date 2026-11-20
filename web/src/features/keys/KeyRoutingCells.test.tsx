import { render, screen } from "@testing-library/react"
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
  const routing = {
    api_key_id: "k",
    model_count: 3,
    no_backup_count: 2,
    policies: [{ name: "coding", requests: 1200 }],
    models: [
      {
        name: "coding",
        requests: 1200,
        kind: "policy",
        backup: "has_backup",
        reason: null,
        provider: null,
      },
      {
        name: "openai:gpt-5",
        requests: 40,
        kind: "pinned",
        backup: "no_backup",
        reason: "pinned",
        provider: "openai",
      },
      {
        name: "google/gemini-x",
        requests: 3,
        kind: "catalog",
        backup: "no_backup",
        reason: "single_offering",
        provider: "gemini",
      },
    ],
  } as KeyRouting

  it("lists the names with no backup and why, and links to Routing", async () => {
    await renderWithRouter(
      <KeyRoutingSummary routing={routing} isPending={false} />,
    )

    expect(screen.getByText("coding (1,200)")).toBeInTheDocument()
    expect(screen.getByText("2 of 3 models have none")).toBeInTheDocument()
    const missing = screen.getByRole("list", { name: "Names with no backup" })
    expect(missing).toHaveTextContent("openai:gpt-5 · pinned to openai")
    expect(missing).toHaveTextContent("google/gemini-x · only gemini serves it")
    expect(missing).not.toHaveTextContent("coding")
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
