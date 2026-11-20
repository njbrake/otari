import { buttonVariants } from "@heroui/react"
import { Link } from "@tanstack/react-router"
import { useRef } from "react"
import { FiMessageSquare } from "react-icons/fi"

import type { UsageEntry } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { CopyableValue } from "@/design-system/actions/CopyField"
import { useObserveFilterState } from "@/features/observe/observeFilters"
import { useCanContribute } from "@/features/organization/access"
import { PeekPanel } from "@/shared/components/PeekPanel"
import { formatDateTime } from "@/shared/helpers/format"
import { useSurfaces } from "@/shared/hooks/useDeployment"
import {
  displayStatus,
  findPricingSelector,
  listToolUsage,
} from "./activityModel"
import { RequestDetail } from "./RequestDetail"
import { RequestTraceLink } from "./RequestTraceLink"
import { describeTool } from "./requestPanelModel"
import { StatusMark } from "./StatusMark"

// The phone touch floor in globals.css reaches HeroUI's Button only.
const LINK_BUTTON = `${buttonVariants({ size: "sm", variant: "ghost" })} max-md:min-h-11`

/** One request of the log, open beside it. */
export function RequestPeek({
  entry,
  position,
  onPriceModel,
  onClose,
  onPrevious,
  onNext,
}: {
  entry: UsageEntry
  /** "3 / 25": where the request sits in the page the arrows walk, when it is on it. */
  position?: string
  onPriceModel?: (model: string, endpoint: string) => void
  onClose: () => void
  onPrevious?: () => void
  onNext?: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  // The id the request was answered under (`Otari-Request-ID`), which every
  // attempt's row shares; a row older than request groups has only its own.
  const requestId = entry.request_group_id || entry.id
  return (
    <PeekPanel
      label="Request detail"
      kind="Request"
      noun="request"
      identity={
        <CopyableValue
          value={requestId}
          label="request ID"
          className="text-mono-caption text-muted"
          isTruncated
        />
      }
      recordKey={entry.id}
      focusRef={headingRef}
      onClose={onClose}
      onPrevious={onPrevious}
      onNext={onNext}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          {/* Focused only by the panel opening, so it draws no ring: it is
              not a control. */}
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="truncate text-title outline-none"
          >
            {entry.model}
          </h2>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusMark status={displayStatus(entry)} />
            <span className="text-mono-caption text-muted">
              {formatDateTime(entry.timestamp)}
            </span>
            {position ? (
              <span
                className="text-mono-caption text-muted"
                title="This request's place in the page the arrows walk"
              >
                {position}
              </span>
            ) : null}
          </span>
        </div>
        <RequestTraceLink entry={entry} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <RequestDetail
          entry={entry}
          onPriceModel={onPriceModel}
          showsRequestId={false}
        />
      </div>
      <RequestPeekActions entry={entry} />
    </PeekPanel>
  )
}

/**
 * Narrow the log to what this request shares with others (its session, its
 * model, the tools it ran), or open its model in the Playground.
 */
function RequestPeekActions({ entry }: { entry: UsageEntry }) {
  const filters = useObserveFilterState("requests")
  const hasPlayground = useSurfaces()("playground")
  // A viewer may not run anything, which is the Playground's own gate too.
  const canRun = useCanContribute()
  const tools = listToolUsage(entry)
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <span className="text-caption">Filter to</span>
      {entry.source_label ? (
        <Button
          size="sm"
          onPress={() =>
            filters.patch({ source_label: entry.source_label ?? "" })
          }
        >
          Session
        </Button>
      ) : null}
      <Button size="sm" onPress={() => filters.patch({ model: [entry.model] })}>
        Model
      </Button>
      {tools.length ? (
        // The tool filter takes one tool, or any of them.
        <Button
          size="sm"
          onPress={() =>
            filters.patch({ tool: tools.length === 1 ? tools[0].tool : "any" })
          }
        >
          {tools.length === 1 ? describeTool(tools[0].tool) : "Tools"}
        </Button>
      ) : null}
      {hasPlayground && canRun ? (
        <Link
          to="/playground"
          // What served it rather than what was asked for: an alias or a
          // policy is not a model the Playground's picker offers.
          search={{ model: findPricingSelector(entry) }}
          className={`${LINK_BUTTON} ml-auto`}
        >
          <FiMessageSquare aria-hidden="true" className="size-4" />
          Open in Playground
        </Link>
      ) : null}
    </div>
  )
}
