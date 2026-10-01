import type { ReactNode } from "react"
import { Dot } from "@/design-system/indicators/Dot"
import type { OutcomeKind } from "./activityModel"

// Recovered is not a failure (the request was served), so it takes the
// neutral fill rather than danger's or success's.
const FILL: Record<OutcomeKind, string> = {
  success: "bg-success",
  recovered: "bg-text-subtle",
  failed: "bg-danger",
}

const INK: Record<OutcomeKind, string> = {
  success: "",
  recovered: "text-muted",
  failed: "text-danger",
}

/**
 * The ink of the line under an outcome: a served request's note is the
 * attempts a fallback recovered, which is worth a warning; the others say why
 * an attempt failed.
 */
export const OUTCOME_NOTE_INK: Record<OutcomeKind, string> = {
  success: "text-warning",
  recovered: "text-subtle",
  failed: "text-danger",
}

/** An outcome's square, for a layout that sets its words elsewhere. */
export function OutcomeDot({
  kind,
  className = "",
}: {
  kind: OutcomeKind
  className?: string
}) {
  return <Dot className={`${FILL[kind]} ${className}`} />
}

/** An outcome's square and, beside it, what it says, in the outcome's ink. */
export function StatusMark({
  kind,
  children,
  className = "",
}: {
  kind: OutcomeKind
  children: ReactNode
  className?: string
}) {
  return (
    <span className={`flex items-center gap-2 ${INK[kind]} ${className}`}>
      <OutcomeDot kind={kind} />
      {children}
    </span>
  )
}
