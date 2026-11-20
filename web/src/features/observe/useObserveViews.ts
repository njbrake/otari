import { useSearch } from "@tanstack/react-router"
import { useState } from "react"

import type { SavedView, SavedViewPage } from "@/client"
import { useSavedViewMutations, useSavedViews } from "@/shared/api/savedViews"
import type { DashboardSearch } from "@/shared/helpers/search"
import { useUrlState } from "@/shared/helpers/urlState"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"
import {
  canonicalQuery,
  hasSpan,
  VIEW_PATCH_DEFAULTS,
  viewPatch,
} from "./observeViews"

const NO_VIEWS: SavedView[] = []

/**
 * A page's views in the selected workspace, and which one the page is showing.
 *
 * The view on screen is the one whose query matches the page's. After a
 * change, the view last matched keeps its name, marked as changed, so "All
 * requests" plus a filter reads as that rather than as nothing. A window
 * dragged on the chart is a moment rather than a view, so while one is set
 * nothing matches.
 */
export function useObserveViews(page: SavedViewPage) {
  const search = useSearch({ strict: false }) as DashboardSearch
  const url = useUrlState(VIEW_PATCH_DEFAULTS)
  const workspaceId = useSelectedWorkspace().selected?.workspace_id ?? ""
  const read = useSavedViews(workspaceId, page)
  const { create, update, remove } = useSavedViewMutations(workspaceId)
  const [lastId, setLastId] = useState("")

  const views = read.data?.data ?? NO_VIEWS
  const query = canonicalQuery(page, search)
  // Two views can hold one query; the one last applied or saved is the one shown.
  const matches = hasSpan(search)
    ? []
    : views.filter((view) => canonicalQuery(page, view.query) === query)
  const matching = matches.find((view) => view.id === lastId) ?? matches[0]
  if (matching && matching.id !== lastId) setLastId(matching.id)
  const last = views.find((view) => view.id === lastId)
  const current = matching ?? last

  const resetErrors = () => {
    create.reset()
    update.reset()
    remove.reset()
  }

  return {
    workspaceId,
    views,
    canShare: read.data?.can_share ?? false,
    isLoading: read.isPending && workspaceId !== "",
    readError: read.error,
    /** The view the page shows, or the one it showed before a change. */
    current,
    /** The page has changed since `current` was applied or saved. */
    isChanged: current !== undefined && matching === undefined,
    matchingId: matching?.id ?? "",
    apply: (view: SavedView) => {
      resetErrors()
      url.patch(viewPatch(view.query))
      setLastId(view.id)
    },
    save: async (name: string, shared: boolean) => {
      resetErrors()
      const saved = await create.mutateAsync({ page, name, query, shared })
      setLastId(saved.id)
    },
    /** Put the page's filters on one of the caller's own views. */
    overwrite: async (view: SavedView) => {
      resetErrors()
      await update.mutateAsync({ id: view.id, body: { query } })
    },
    rename: async (view: SavedView, name: string) => {
      resetErrors()
      await update.mutateAsync({ id: view.id, body: { name } })
    },
    setShared: async (view: SavedView, shared: boolean) => {
      resetErrors()
      await update.mutateAsync({ id: view.id, body: { shared } })
    },
    remove: async (view: SavedView) => {
      resetErrors()
      await remove.mutateAsync(view.id)
      if (view.id === lastId) setLastId("")
    },
    isSaving: create.isPending || update.isPending,
    isRemoving: remove.isPending,
    error: create.error ?? update.error ?? remove.error,
    resetErrors,
  }
}

export type ObserveViews = ReturnType<typeof useObserveViews>
