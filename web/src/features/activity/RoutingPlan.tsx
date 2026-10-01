import type { UsageEntry } from "@/client"
import { Dot } from "@/design-system/indicators/Dot"
import { useRequestGroups } from "@/shared/api/usage"
import {
  describeSelectionReason,
  findPricingSelector,
  sortPlanRows,
  withStatusCode,
} from "./activityModel"

// The whole plan behind one routed request: every candidate that ran, in order,
// with the one that served marked, and why each earlier one failed. This is the
// answer to "a fallback fired, so what actually served me", which no single row
// can give.
export function RoutingPlan({ entry }: { entry: UsageEntry }) {
  const groupId = entry.request_group_id
  const group = useRequestGroups(groupId ? [groupId] : [])
  // Only rows of this row's own group are the plan. The lookup keeps previous data
  // across a key change, so this is what stops another request's plan from ever
  // being narrated as this one's.
  const siblings = groupId
    ? (group.data ?? []).filter((row) => row.request_group_id === groupId)
    : []
  // Falls back to the row itself while the lookup is in flight (and for a row
  // that carries no group), so the section never flashes empty and never
  // claims a one-attempt plan it did not read.
  const attempts = sortPlanRows(siblings.length ? siblings : [entry])
  const isComplete = siblings.length > 0
  const served = attempts.find((attempt) => attempt.status === "success")
  const failed = attempts.filter((attempt) => attempt.status !== "success")
  const total = entry.attempt_count ?? attempts.length

  // "Loading" only while a lookup is actually outstanding: a failed lookup, or a
  // row that carries no group to look up, would otherwise sit on that line forever.
  const summary = !isComplete ? (
    group.isError ? (
      "Could not load this request's other attempts."
    ) : groupId ? (
      "Loading the rest of this request's attempts…"
    ) : (
      "This row carries no request group, so its other attempts cannot be found."
    )
  ) : served ? (
    <>
      Served on attempt {served.attempt_position ?? "?"} of {total}:{" "}
      <span className="text-mono-caption">{findPricingSelector(served)}</span>
      {failed.length
        ? `, after ${failed.length} failed ${failed.length === 1 ? "attempt" : "attempts"}`
        : ""}
    </>
  ) : failed.some((attempt) => attempt.status === "error") ? (
    "No candidate served this request."
  ) : (
    "This request has no outcome row yet."
  )

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-overline">Routing · {entry.policy_name}</h3>
      <p className="text-caption text-foreground">{summary}</p>
      <table
        aria-label={`Routing plan for policy ${entry.policy_name}`}
        className="w-full table-fixed border border-border-strong text-sm"
      >
        <thead>
          <tr className="border-b border-border text-left">
            <th scope="col" className="w-7 px-2 py-1.5 text-overline">
              #
            </th>
            <th scope="col" className="px-2 py-1.5 text-overline">
              Target
            </th>
            <th scope="col" className="w-24 px-2 py-1.5 text-overline">
              Outcome
            </th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => (
            <tr
              key={attempt.id}
              className="border-t border-border-subtle align-top first:border-t-0"
            >
              <td className="px-2 py-1.5 text-mono-caption">
                {attempt.attempt_position ?? "?"}
              </td>
              <td className="px-2 py-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 text-mono-caption break-all">
                  {findPricingSelector(attempt)}
                  {attempt.id === entry.id && attempts.length > 1 ? (
                    <span className="text-caption text-subtle">this row</span>
                  ) : null}
                </div>
                <div className="text-caption text-subtle">
                  {describeSelectionReason(attempt.selection_reason) ?? "—"}
                </div>
              </td>
              <td className="px-2 py-1.5">
                {attempt.status === "success" ? (
                  <span className="flex items-center gap-1.5">
                    <Dot className="bg-success" />
                    served
                  </span>
                ) : (
                  <span className="flex flex-col">
                    <span className="text-mono-caption whitespace-nowrap text-warning">
                      {withStatusCode(attempt.status_code, "failed")}
                    </span>
                    <span className="text-caption text-subtle">
                      {attempt.status === "absorbed"
                        ? "fell back"
                        : "ended here"}
                    </span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {failed
        .filter((attempt) => attempt.error_message)
        .map((attempt) => (
          <p
            key={attempt.id}
            className="border border-border-strong bg-surface-subtle px-2.5 py-2 text-mono-micro break-all text-muted"
          >
            Attempt {attempt.attempt_position ?? "?"}: {attempt.error_message}
          </p>
        ))}
      <p className="text-caption text-subtle">
        Cost and tool charges settle on the attempt that served, so a failed
        attempt carries its tokens and no charge.
      </p>
    </section>
  )
}
