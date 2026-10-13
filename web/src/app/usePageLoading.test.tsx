import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useNavigate,
} from "@tanstack/react-router"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { type ReactNode, useState } from "react"
import { describe, expect, it } from "vitest"
import { usePageLoading } from "@/app/usePageLoading"
import { flushRouter, withRouter } from "@/tests/router"

/** Reads that answer only when the test says so, one per key. */
function deferredReads() {
  const pending = new Map<string, () => void>()
  return {
    read: (key: string) =>
      new Promise<string>((resolve) => {
        pending.set(key, () => resolve(key))
      }),
    answer: (key: string) => pending.get(key)?.(),
  }
}

function Probe({ read }: { read: (key: string) => Promise<string> }) {
  const navigate = useNavigate()
  const [tick, setTick] = useState(0)
  const query = useQuery({
    queryKey: ["probe", tick],
    queryFn: () => read(`read-${tick}`),
    placeholderData: (previous) => previous,
  })
  const isLoading = usePageLoading()
  return (
    <>
      <p>{isLoading ? "waiting" : "settled"}</p>
      <p>{query.data ?? "no data"}</p>
      <button type="button" onClick={() => setTick((n) => n + 1)}>
        tick
      </button>
      <button type="button" onClick={() => void query.refetch()}>
        refetch
      </button>
      <button
        type="button"
        onClick={() =>
          void navigate({ to: "/", search: { status: "error" }, replace: true })
        }
      >
        filter
      </button>
    </>
  )
}

async function renderProbe() {
  const reads = deferredReads()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const Router = withRouter()
  render(<Probe read={reads.read} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <Router>{children}</Router>
      </QueryClientProvider>
    ),
  })
  await flushRouter()
  return reads
}

describe("usePageLoading", () => {
  it("is on while the page's first read is in flight, and off once it answers", async () => {
    const reads = await renderProbe()
    expect(screen.getByText("waiting")).toBeInTheDocument()
    reads.answer("read-0")
    expect(await screen.findByText("read-0")).toBeInTheDocument()
    expect(screen.getByText("settled")).toBeInTheDocument()
  })

  it("stays off for a refetch of a read that already has an answer", async () => {
    const user = userEvent.setup()
    const reads = await renderProbe()
    reads.answer("read-0")
    await screen.findByText("read-0")
    await user.click(screen.getByRole("button", { name: "refetch" }))
    expect(screen.getByText("settled")).toBeInTheDocument()
  })

  it("stays off for a new read the reader did not ask for, as live mode's clock starts", async () => {
    const user = userEvent.setup()
    const reads = await renderProbe()
    reads.answer("read-0")
    await screen.findByText("read-0")
    // Let the wait close: every read has to stay settled for a beat first.
    await waitFor(() => expect(screen.getByText("settled")).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 200))
    await user.click(screen.getByRole("button", { name: "tick" }))
    expect(screen.getByText("settled")).toBeInTheDocument()
  })

  it("comes back on when a change to the URL starts a new read", async () => {
    const user = userEvent.setup()
    const reads = await renderProbe()
    reads.answer("read-0")
    await screen.findByText("read-0")
    await new Promise((resolve) => setTimeout(resolve, 200))
    await user.click(screen.getByRole("button", { name: "filter" }))
    await user.click(screen.getByRole("button", { name: "tick" }))
    expect(await screen.findByText("waiting")).toBeInTheDocument()
    reads.answer("read-1")
    await waitFor(() => expect(screen.getByText("settled")).toBeInTheDocument())
  })

  it("stays on while the next page's code loads, past the time a read has to start", async () => {
    let release = () => {}
    const chunk = new Promise<void>((resolve) => {
      release = resolve
    })
    function Shell() {
      const isLoading = usePageLoading()
      return (
        <>
          <p>{isLoading ? "waiting" : "settled"}</p>
          <Outlet />
        </>
      )
    }
    const root = createRootRoute({ component: Shell })
    const router = createRouter({
      routeTree: root.addChildren([
        createRoute({ getParentRoute: () => root, path: "/" }),
        // A route whose loading outlasts the time a page has to start a read,
        // as a slow code-split chunk does.
        createRoute({
          getParentRoute: () => root,
          path: "/slow",
          loader: () => chunk,
          component: () => <p>slow page</p>,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    })
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText("settled")).toBeInTheDocument())

    act(() => {
      void router.history.push("/slow")
    })
    expect(await screen.findByText("waiting")).toBeInTheDocument()
    await act(() => new Promise((resolve) => setTimeout(resolve, 1200)))
    expect(screen.getByText("waiting")).toBeInTheDocument()

    release()
    expect(await screen.findByText("slow page")).toBeInTheDocument()
    await waitFor(
      () => expect(screen.getByText("settled")).toBeInTheDocument(),
      { timeout: 2000 },
    )
  })
})
