import { useState } from "react"
import {
  useCreateSavedView,
  useDeleteSavedView,
  useSavedViews,
} from "@/shared/api/savedViews"
import {
  type ActivityUrl,
  BUILT_IN_VIEWS,
  type BuiltInView,
  viewPatch,
  viewQuery,
} from "./activityQuery"

/**
 * The saved views of the page, and which one it is showing.
 *
 * A view is the page's query string under a name, so the one on screen is the
 * view whose query matches the URL's. After a change, the view last matched
 * keeps its name, marked as changed, so "All requests" plus a filter reads as
 * that rather than as nothing. A brushed span is a moment rather than part of a
 * view, so while one is set nothing matches.
 */
export function useActivityViews({
  url,
  workspaceId,
  hasSpan,
  onApplied,
}: {
  url: ActivityUrl
  workspaceId: string
  hasSpan: boolean
  /** Called once a view is applied, for state the URL does not hold. */
  onApplied: () => void
}) {
  const saved = useSavedViews(workspaceId, "activity")
  const create = useCreateSavedView(workspaceId)
  const remove = useDeleteSavedView(workspaceId)
  const [lastMatched, setLastMatched] = useState<string>()

  const query = viewQuery(url)
  const views = saved.data ?? []
  const matching = hasSpan
    ? undefined
    : [...BUILT_IN_VIEWS, ...views].find((view) => view.query === query)
  if (matching && matching.name !== lastMatched) setLastMatched(matching.name)

  return {
    views,
    current: matching?.name ?? lastMatched,
    /** The view the URL matches exactly, if any: the one its menu checks. */
    matching,
    isDirty: !matching && lastMatched !== undefined,
    apply: (view: BuiltInView) => {
      url.patch({ ...viewPatch(view.query), request: "" })
      setLastMatched(view.name)
      onApplied()
    },
    save: (name: string, shared: boolean) => {
      remove.reset()
      return create
        .mutateAsync({ page: "activity", name, query, shared })
        .then(() => setLastMatched(name))
    },
    remove: (id: string) => {
      create.reset()
      remove.mutate(id)
    },
    isSaving: create.isPending,
    error: create.error ?? remove.error,
    /** Forget a failed save or delete, once the menu that showed it closes. */
    clearError: () => {
      create.reset()
      remove.reset()
    },
  }
}
