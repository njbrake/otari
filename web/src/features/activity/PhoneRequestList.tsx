import type { UsageEntry } from "@/client"
import { Button } from "@/design-system/actions/Button"
import { EmptyMessage } from "@/design-system/feedback/EmptyMessage"
import { Skeleton } from "@/design-system/feedback/Skeleton"
import { PhoneRow } from "./PhoneRow"
import { PHONE_BATCH } from "./requestGroups"

/**
 * The request log on a phone: three-line rows read top to bottom, with more
 * appended at the end rather than paged.
 */
export function PhoneRequestList({
  rows,
  isLoading,
  senderOf,
  openId,
  onOpen,
  onMore,
  isFetchingMore,
  emptyContent,
}: {
  rows: UsageEntry[]
  isLoading: boolean
  senderOf: (entry: UsageEntry) => string
  openId: string
  onOpen: (id: string) => void
  /** Appends the next rows, or is absent once the log has no more to show. */
  onMore: (() => void) | undefined
  isFetchingMore: boolean
  emptyContent: string
}) {
  if (isLoading && rows.length === 0) {
    return (
      <div className="flex flex-col gap-3 py-3" aria-busy>
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="py-6">
        <EmptyMessage>{emptyContent}</EmptyMessage>
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      <ul aria-label="Activity log" className="-mx-4 my-0 list-none p-0">
        {rows.map((entry) => (
          <li key={entry.id}>
            <PhoneRow
              entry={entry}
              sender={senderOf(entry)}
              isOpen={entry.id === openId}
              onOpen={() => onOpen(entry.id)}
            />
          </li>
        ))}
      </ul>
      {onMore ? (
        <div className="pt-4 pb-6">
          <Button
            fullWidth
            className="min-h-11"
            onPress={onMore}
            isPending={isFetchingMore}
          >
            Load {PHONE_BATCH} more
          </Button>
        </div>
      ) : null}
    </div>
  )
}
