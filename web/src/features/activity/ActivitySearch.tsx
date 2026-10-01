import { useEffect, useState } from "react"
import { SearchField } from "@/design-system/forms/SearchField"
import { useDebounced } from "@/shared/hooks/useDebounced"

/**
 * A search box typed freely and committed once typing settles, so the query
 * runs per term rather than per keystroke: the log's, and a column menu's over
 * its values.
 *
 * `value` is the committed term (the URL's). When it changes from outside, a
 * view applied or the filters cleared, the box follows; its own commits leave
 * the text alone, so the caret never jumps.
 */
export function ActivitySearch({
  value,
  onCommit,
  placeholder,
  label = "Search requests",
  className,
}: {
  value: string
  onCommit: (term: string) => void
  placeholder: string
  label?: string
  className?: string
}) {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  const settled = useDebounced(text)
  if (value !== seen) {
    setSeen(value)
    if (value !== settled) setText(value)
  }
  // Only a term the box still shows: straight after an outside change the
  // debounced text is the old one, and committing it would undo the change.
  useEffect(() => {
    if (settled === text && settled !== value) onCommit(settled)
  }, [settled, text, value, onCommit])
  return (
    <SearchField
      label={label}
      value={text}
      onChange={setText}
      placeholder={placeholder}
      className={className}
    />
  )
}
