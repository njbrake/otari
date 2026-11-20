import { useMutation, useQueryClient } from "@tanstack/react-query"

import type {
  UsageDeleteRequest,
  UsageDeleteResult,
  UsageSetPriceRequest,
  UsageSetPriceResult,
} from "@/client"
import { apiFetch } from "@/shared/api/client"
import { BUDGETS, USAGE } from "@/shared/api/queryKeys"

/**
 * The operator's two bulk writes over imported usage: delete rows, or recost
 * them at manual rates. Both reach only rows the gateway did not serve, so a
 * budget's spend never moves; every usage read is refreshed after either, and
 * the budgets list with it, whose figures read the same rows.
 */
function useUsageWrite<Body, Result>(method: "DELETE" | "POST", path: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: Body) =>
      apiFetch<Result>(path, { method, body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [USAGE] })
      void queryClient.invalidateQueries({ queryKey: [BUDGETS] })
    },
  })
}

/** `DELETE /usage`: remove the imported rows a selection names. */
export function useDeleteUsage() {
  return useUsageWrite<UsageDeleteRequest, UsageDeleteResult>(
    "DELETE",
    "/usage",
  )
}

/** `POST /usage/set-price`: recost the imported rows a selection names at manual rates. */
export function useSetUsagePrice() {
  return useUsageWrite<UsageSetPriceRequest, UsageSetPriceResult>(
    "POST",
    "/usage/set-price",
  )
}
