/** One key of the budget chart's legend: a swatch in the series' fill, and its name. */
export function LegendSwatch({
  className,
  children,
}: {
  /** The swatch's fill. */
  className: string
  children: string
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span aria-hidden className={`size-2 ${className}`} />
      {children}
    </span>
  )
}
