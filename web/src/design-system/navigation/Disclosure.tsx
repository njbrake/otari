import { Disclosure as HeroDisclosure } from "@heroui/react"
import type { ReactNode } from "react"

/**
 * A heading that opens to reveal what is under it.
 *
 * Right for detail an operator asks for (a request's raw payload, a provider's
 * full error), and wrong for anything they need in order to decide: content
 * behind a click is content most people never read, so a collapsed section is a
 * decision that it is optional.
 *
 * The chevron travels on the 150ms rung and is guarded, like the rail rows it
 * shares that duration with. HeroUI's own indicator carries the rotation, which
 * is why there is no transform spelled here.
 *
 * Uncontrolled unless given `isExpanded`. A caller that controls it can mount
 * `children` only while it is open, for a panel whose content reads from the
 * server.
 */
export function Disclosure({
  heading,
  children,
  isDefaultExpanded = false,
  isExpanded,
  onExpandedChange,
}: {
  /** The always-visible label. It is the button, so it says what opening reveals. */
  heading: ReactNode
  children: ReactNode
  isDefaultExpanded?: boolean
  isExpanded?: boolean
  onExpandedChange?: (isExpanded: boolean) => void
}) {
  return (
    <HeroDisclosure.Root
      defaultExpanded={isDefaultExpanded}
      isExpanded={isExpanded}
      onExpandedChange={onExpandedChange}
    >
      <HeroDisclosure.Heading>
        <HeroDisclosure.Trigger className="flex min-h-11 w-full items-center justify-between gap-2 text-body">
          {heading}
          <HeroDisclosure.Indicator />
        </HeroDisclosure.Trigger>
      </HeroDisclosure.Heading>
      <HeroDisclosure.Content>
        <HeroDisclosure.Body className="pb-3">{children}</HeroDisclosure.Body>
      </HeroDisclosure.Content>
    </HeroDisclosure.Root>
  )
}
