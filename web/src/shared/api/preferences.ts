import { useQuery } from "@tanstack/react-query"
import type { PreferenceKey, UserPreference } from "@/client"
import { apiFetch } from "@/shared/api/client"
import { PREFERENCES } from "@/shared/api/queryKeys"

/** The query key one preference is cached under. */
export const preferenceKey = (key: PreferenceKey) => [PREFERENCES, key] as const

const preferencePath = (key: PreferenceKey) =>
  `/me/preferences/${encodeURIComponent(key)}`

/**
 * What the signed-in person stored under `key`. The answer carries a null
 * `value` when nothing is stored, so an unset preference is not an error.
 */
export function usePreference(key: PreferenceKey) {
  return useQuery({
    queryKey: preferenceKey(key),
    queryFn: () => apiFetch<UserPreference>(preferencePath(key)),
    // Only this tab writes it, and every write seeds the cache first.
    staleTime: 5 * 60_000,
  })
}

/** Replace what the signed-in person stored under `key`. */
export function putPreference(
  key: PreferenceKey,
  value: NonNullable<UserPreference["value"]>,
): Promise<UserPreference> {
  return apiFetch<UserPreference>(preferencePath(key), {
    method: "PUT",
    body: JSON.stringify({ value }),
  })
}

/** Forget what the signed-in person stored under `key`. */
export function clearPreference(key: PreferenceKey): Promise<void> {
  return apiFetch<void>(preferencePath(key), { method: "DELETE" })
}
