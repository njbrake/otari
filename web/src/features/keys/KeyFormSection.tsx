import type { ReactNode } from "react"

/**
 * One group of a key's create or edit form: an overline naming it, a rule
 * above, and an optional caption under the heading, so a long form reads as a
 * few questions rather than one column of fields.
 */
export function KeyFormSection({
  title,
  caption,
  children,
}: {
  title: string
  caption?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-3 border-t border-border-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-overline">{title}</h3>
        {caption ? <p className="text-caption">{caption}</p> : null}
      </div>
      {children}
    </section>
  )
}
