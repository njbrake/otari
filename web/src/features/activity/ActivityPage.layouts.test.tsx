import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ActivityPage } from "@/features/activity/ActivityPage"
import {
  entry,
  lastList,
  listCalls,
  listCarries,
  mockApi,
  renderPage,
  rowOf,
} from "@/tests/activity"

// The page's keys, and the arrangement each viewport gets.

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ActivityPage", () => {
  describe("the keyboard", () => {
    it("steps with j and k, and leaves them to a field being typed in", async () => {
      const user = userEvent.setup()
      mockApi({
        rows: [
          entry({ id: "a", model: "first-model" }),
          entry({ id: "b", model: "second-model" }),
        ],
      })
      renderPage(<ActivityPage />)
      await user.click(await rowOf("first-model"))
      const heading = () =>
        within(
          screen.getByRole("complementary", { name: "Request details" }),
        ).getByRole("heading", { level: 2 })

      await user.keyboard("j")
      await waitFor(() => expect(heading()).toHaveTextContent("second-model"))

      await user.click(screen.getByLabelText("Search requests"))
      await user.keyboard("k")
      expect(heading()).toHaveTextContent("second-model")
    })

    it("leaves a chord to the browser", async () => {
      const user = userEvent.setup()
      mockApi({
        rows: [
          entry({ id: "a", model: "first-model" }),
          entry({ id: "b", model: "second-model" }),
        ],
      })
      renderPage(<ActivityPage />)
      await user.click(await rowOf("first-model"))
      const heading = within(
        screen.getByRole("complementary", { name: "Request details" }),
      ).getByRole("heading", { level: 2 })

      await user.keyboard("{Control>}j{/Control}{Meta>}k{/Meta}")
      expect(heading).toHaveTextContent("first-model")
    })
  })

  describe("switching layouts", () => {
    it("moves between the desk and the phone as the viewport crosses md", async () => {
      const listeners = new Set<() => void>()
      let isPhone = false
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            get matches() {
              return query.includes("max-width: 767px") && isPhone
            },
            media: query,
            addEventListener: (_: string, listener: () => void) =>
              listeners.add(listener),
            removeEventListener: (_: string, listener: () => void) =>
              listeners.delete(listener),
          }) as unknown as MediaQueryList,
      )
      mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      expect(
        await screen.findByRole("table", { name: "Activity log" }),
      ).toBeInTheDocument()

      isPhone = true
      for (const listener of listeners) listener()
      expect(
        await screen.findByRole("button", { name: "Filter and sort" }),
      ).toBeInTheDocument()
      expect(
        screen.queryByRole("table", { name: "Activity log" }),
      ).not.toBeInTheDocument()
    })
  })

  describe("at a narrow desk", () => {
    it("reads a request in a drawer over the log, which keeps its lanes", async () => {
      const user = userEvent.setup()
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query.includes("max-width: 1279px"),
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
          }) as MediaQueryList,
      )
      mockApi({ rows: [entry()] })
      renderPage(<ActivityPage />)
      await user.click(await rowOf("gpt-4o"))

      const drawer = await screen.findByRole("dialog", { name: "Request" })
      expect(
        within(drawer).getByRole("complementary", { name: "Request details" }),
      ).toBeInTheDocument()
      await user.click(
        within(drawer).getByRole("button", { name: "Close (Esc)" }),
      )
      await waitFor(() =>
        expect(
          screen.queryByRole("complementary", { name: "Request details" }),
        ).not.toBeInTheDocument(),
      )
      // The table kept its full set of lanes behind the drawer.
      expect(
        screen.getByRole("columnheader", { name: /Latency/ }),
      ).toBeInTheDocument()
    })
  })

  describe("on a phone", () => {
    function asPhone() {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query.includes("max-width: 767px"),
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
          }) as MediaQueryList,
      )
    }

    it("lists requests as rows and reads one full screen", async () => {
      const user = userEvent.setup()
      asPhone()
      mockApi({ rows: [entry({ model: "phone-model" })], viewer: "member" })
      renderPage(<ActivityPage />)

      await user.click(
        await screen.findByRole("button", { name: /phone-model/ }),
      )
      expect(
        await screen.findByRole("complementary", { name: "Request details" }),
      ).toBeInTheDocument()
      await user.click(screen.getByRole("button", { name: "Activity" }))
      expect(
        screen.queryByRole("complementary", { name: "Request details" }),
      ).not.toBeInTheDocument()
    })

    it("says it is loading until the first rows arrive", async () => {
      asPhone()
      mockApi({ rows: [entry({ model: "phone-model" })], viewer: "member" })
      renderPage(<ActivityPage />)

      expect(await screen.findByText("Loading…")).toBeInTheDocument()
      expect(
        screen.queryByText("No requests recorded yet."),
      ).not.toBeInTheDocument()
      await screen.findByRole("button", { name: /phone-model/ })
    })

    it("narrows to a bar's stretch of the window when one is picked", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /gpt-4o/ })

      screen.getByRole("slider", { name: "Filter by time" }).focus()
      await user.keyboard("{ArrowRight}")
      await waitFor(() =>
        expect(lastList(calls).get("end_date")).not.toBeNull(),
      )
    })

    it("loads the next batch after the rows it has, rather than all of them again", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({
        rows: Array.from({ length: 20 }, (_, index) =>
          entry({ id: `row-${index}`, model: `model-${index}` }),
        ),
        viewer: "member",
      })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /model-0/ })

      await user.click(screen.getByRole("button", { name: "Load 20 more" }))
      await waitFor(() =>
        expect(
          listCalls(calls).some(
            (url) => url.includes("skip=20") && url.includes("limit=20"),
          ),
        ).toBe(true),
      )
      expect(listCalls(calls).some((url) => url.includes("limit=40"))).toBe(
        false,
      )
    })

    it("marks an excluded value in the sheet, unchecked", async () => {
      const user = userEvent.setup()
      asPhone()
      mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />, "/activity?exclude_status=error")
      await screen.findByRole("button", { name: /gpt-4o/ })

      await user.click(screen.getByRole("button", { name: "Filter and sort" }))
      const sheet = await screen.findByRole("dialog", {
        name: "Filter and sort",
      })
      const failed = within(sheet).getByRole("checkbox", { name: "Failed" })
      expect(failed).not.toBeChecked()
      const row = failed.closest("div.flex.min-h-11") as HTMLElement
      expect(within(row).getByText("excluded")).toBeInTheDocument()
    })

    it("sorts and filters from one sheet", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /gpt-4o/ })

      await user.click(screen.getByRole("button", { name: "Filter and sort" }))
      const sheet = await screen.findByRole("dialog", {
        name: "Filter and sort",
      })
      await user.click(
        within(sheet).getByRole("radio", { name: "Highest cost" }),
      )
      await listCarries(calls, "sort", "cost")
      await user.click(within(sheet).getByRole("checkbox", { name: "Failed" }))
      await listCarries(calls, "status", "error")
    })

    it("picks a cost threshold from the sheet, and a second press clears it", async () => {
      const user = userEvent.setup()
      asPhone()
      const { calls } = mockApi({ rows: [entry()], viewer: "member" })
      renderPage(<ActivityPage />)
      await screen.findByRole("button", { name: /gpt-4o/ })

      await user.click(screen.getByRole("button", { name: "Filter and sort" }))
      const sheet = await screen.findByRole("dialog", {
        name: "Filter and sort",
      })
      const step = within(sheet).getByRole("radio", { name: "> $0.10" })
      await user.click(step)
      await listCarries(calls, "cost_gt", "0.1")
      expect(step).toBeChecked()
      // The unfiltered list is still cached, so no request says the threshold
      // is gone; the chip, which reads it back from the URL, does.
      await user.click(step)
      await waitFor(() => expect(step).not.toBeChecked())
    })
  })
})
