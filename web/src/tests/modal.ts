/**
 * The open dialog's backdrop, for asserting that a click outside dismisses.
 *
 * A backdrop carries no role and no name, so there is nothing for Testing
 * Library to query it by and the only handle is HeroUI's own `data-slot`. That
 * is an internal, which is exactly why it is spelled once here rather than at
 * every call site: a rename upstream is then one line rather than a sweep.
 */
export function getModalBackdrop(): HTMLElement {
  const backdrop = document.querySelector<HTMLElement>(
    '[data-slot="modal-backdrop"]',
  )
  if (backdrop === null) {
    throw new Error("Expected an open modal backdrop")
  }
  return backdrop
}
