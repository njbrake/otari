import { TextButton } from "@/design-system/actions/TextButton"
import { InfoBanner } from "@/design-system/feedback/InfoBanner"
import { shortId } from "./activityModel"

/** Said in place of the panel when a linked request cannot be read. */
export function MissingRequest({
  id,
  onClose,
}: {
  id: string
  onClose: () => void
}) {
  return (
    <InfoBanner tone="warning">
      Request <span className="text-mono-caption">{shortId(id)}</span> is not in
      the log: it was deleted, or is one you cannot see.{" "}
      <TextButton onPress={onClose}>Close</TextButton>
    </InfoBanner>
  )
}
