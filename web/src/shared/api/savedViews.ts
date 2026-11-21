import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  CreateSavedViewRequest,
  SavedView,
  SavedViewPage,
  SavedViews,
  UpdateSavedViewRequest,
} from "@/client"
import { apiFetch } from "@/shared/api/client"
import { SAVED_VIEWS } from "@/shared/api/queryKeys"

const viewsPath = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/saved-views`

/** The query key one page's views in one workspace are cached under. */
export const savedViewsKey = (workspaceId: string, page: SavedViewPage) =>
  [SAVED_VIEWS, workspaceId, page] as const

/**
 * The views a page offers in a workspace: its built-in ones, the caller's own,
 * then those shared with the workspace. Read only while `enabled`, which the
 * menu turns on once it has a workspace to ask about.
 */
export function useSavedViews(
  workspaceId: string,
  page: SavedViewPage,
  enabled = true,
) {
  return useQuery({
    queryKey: savedViewsKey(workspaceId, page),
    queryFn: () =>
      apiFetch<SavedViews>(
        `${viewsPath(workspaceId)}?page=${encodeURIComponent(page)}`,
      ),
    enabled: enabled && workspaceId !== "",
    staleTime: 60_000,
  })
}

/** The writes the views menu makes, each invalidating the workspace's lists. */
export function useSavedViewMutations(workspaceId: string) {
  const queryClient = useQueryClient()
  const onSuccess = () =>
    void queryClient.invalidateQueries({
      queryKey: [SAVED_VIEWS, workspaceId],
    })
  const create = useMutation({
    mutationFn: (body: CreateSavedViewRequest) =>
      apiFetch<SavedView>(viewsPath(workspaceId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    // Listed at once, so the menu can name the view it just saved before the re-read lands.
    onSuccess: (saved) => {
      queryClient.setQueryData<SavedViews>(
        savedViewsKey(workspaceId, saved.page),
        (listed) =>
          listed ? { ...listed, data: [...listed.data, saved] } : listed,
      )
      onSuccess()
    },
  })
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateSavedViewRequest }) =>
      apiFetch<SavedView>(
        `${viewsPath(workspaceId)}/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
        },
      ),
    onSuccess,
  })
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${viewsPath(workspaceId)}/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess,
  })
  return { create, update, remove }
}
