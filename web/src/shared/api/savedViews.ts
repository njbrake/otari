import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { CreateSavedViewRequest, SavedView, SavedViews } from "@/client"
import { apiFetch } from "@/shared/api/client"
import { SAVED_VIEWS } from "@/shared/api/queryKeys"

type SavedViewPage = CreateSavedViewRequest["page"]

const base = (workspaceId: string) =>
  `/workspaces/${encodeURIComponent(workspaceId)}/saved-views`

// The caller's own views of `page` first, then those shared with the workspace.
// The server caps the menu, and trims only other people's shared views to fit.
export function useSavedViews(workspaceId: string, page: SavedViewPage) {
  return useQuery({
    queryKey: [SAVED_VIEWS, workspaceId, page],
    queryFn: () =>
      apiFetch<SavedViews>(`${base(workspaceId)}?page=${page}`).then(
        (body) => body.data,
      ),
    enabled: workspaceId !== "",
    staleTime: 60_000,
  })
}

export function useCreateSavedView(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSavedViewRequest) =>
      apiFetch<SavedView>(base(workspaceId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [SAVED_VIEWS, workspaceId],
      })
    },
  })
}

export function useDeleteSavedView(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (viewId: string) =>
      apiFetch(`${base(workspaceId)}/${encodeURIComponent(viewId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [SAVED_VIEWS, workspaceId],
      })
    },
  })
}
