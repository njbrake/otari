import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  MergeUserRequest,
  MergeUserResponse,
  UpdateUserRequest,
  User,
} from "@/client"
import { apiFetch } from "@/shared/api/client"
import { fetchAllRows } from "@/shared/api/paging"
import { BUDGETS, DEPLOYMENT_ADMIN, USERS } from "@/shared/api/queryKeys"

const fetchAllUsers = () => fetchAllRows<User>("/users")

// Gated for the same reason as `useBudgets` above.
export function useUsers(enabled = true) {
  return useQuery({
    queryKey: [USERS],
    queryFn: fetchAllUsers,
    staleTime: 60_000,
    enabled,
  })
}

// Assigning a budget to a user changes that budget's usage rollup, so a user
// write invalidates the budgets list too.
function invalidateUserViews(
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  void queryClient.invalidateQueries({ queryKey: [USERS] })
  void queryClient.invalidateQueries({ queryKey: [BUDGETS] })
}

export function useUpdateUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserRequest }) =>
      apiFetch<User>(`/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateUserViews(queryClient),
  })
}

/**
 * Fold one user record into another, or with `preview` say what would move.
 *
 * A preview changes nothing, so only a merge refreshes the views a merge
 * changes: the users list, budgets whose spend moved, and the accounts list.
 */
export function useMergeUser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: MergeUserRequest }) =>
      apiFetch<MergeUserResponse>(`/users/${encodeURIComponent(id)}/merge`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      if (result.preview) return
      invalidateUserViews(queryClient)
      void queryClient.invalidateQueries({ queryKey: [DEPLOYMENT_ADMIN] })
    },
  })
}
