import { PERIODS, type WindowKind } from "@/features/spend/period"

/**
 * The windows a person's page reads over: the calendar month so far, which it
 * opens on, then Home's windows that run to now. Yesterday is left out because
 * the session and refusal counts beside the spend read from a start alone.
 */
export const PERSON_PERIODS: { value: WindowKind; label: string }[] = [
  { value: "month", label: "This month" },
  ...PERIODS.filter((period) => period.value !== "yesterday"),
]

export const DEFAULT_PERSON_PERIOD: WindowKind = "month"

/** The window a URL's `period` names, or this month for one it does not. */
export function personPeriodFromUrl(value: string): WindowKind {
  return (
    PERSON_PERIODS.find((period) => period.value === value)?.value ??
    DEFAULT_PERSON_PERIOD
  )
}
