/**
 * A thin bar along the bottom edge of the top bar while the page is waiting on
 * a read, for the waits a section's own loading state does not cover: a page
 * that fills in piece by piece, or a filter change whose old numbers stay up
 * until the new ones land.
 *
 * Indeterminate, because no read here reports how far along it is, and a bar
 * that advanced anyway would be inventing a number. It fades in after a beat,
 * so a read that answers quickly never shows it.
 *
 * Hidden from assistive tech: the sections that are waiting say so in their
 * own regions, and a second announcement for the same wait is noise. The
 * parent positions it, and must be `relative`.
 */
export function LoadingBar({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <span aria-hidden="true" className="otari-loading-bar" />
  ) : null
}
