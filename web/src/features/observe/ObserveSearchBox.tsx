import { useEffect, useState } from "react"

import { SearchField } from "@/design-system/forms/SearchField"
import { useDebounced } from "@/shared/hooks/useDebounced"

// The server refuses a longer term, so the field stops there.
const MAX_SEARCH_LENGTH = 200

/**
 * The request log's search box: typed freely and committed once typing
 * settles, so the log is read per term rather than per keystroke.
 *
 * `value` is the committed term (the URL's). When it changes from elsewhere,
 * the filters cleared or a link followed, the box follows; its own commits
 * leave the text alone, so the caret never jumps.
 */
export function ObserveSearchBox({
  value,
  onCommit,
}: {
  value: string
  onCommit: (term: string) => void
}) {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  const settled = useDebounced(text, 300)
  if (value !== seen) {
    setSeen(value)
    if (value !== settled.trim()) setText(value)
  }
  // Only a term the box still shows: straight after a change from elsewhere the
  // settled text is the old one, and committing it would undo the change.
  useEffect(() => {
    const term = settled.trim()
    if (settled === text && term !== value) onCommit(term)
  }, [settled, text, value, onCommit])
  return (
    <SearchField
      label="Search requests"
      placeholder="Request ID, user, model, source"
      value={text}
      onChange={setText}
      maxLength={MAX_SEARCH_LENGTH}
      className="w-full"
    />
  )
}
