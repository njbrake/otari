import { useState } from "react"
import { FiGitBranch } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { OfferingPicker } from "@/features/models/OfferingPicker"
import { useRoutingSyncing } from "@/shared/api/routing"

import { selectorText } from "./PolicyCells"
import { SaveBar } from "./PolicyEditor"

/**
 * An alias: one name for one model, sent as written. It has no backups of its
 * own, so the way to add some is to turn it into a policy of the same name,
 * which callers keep sending.
 */
export function AliasEditor({
  name,
  target,
  isReadOnly,
  isConfig,
  onTurnIntoPolicy,
  onSave,
  isPending,
  error,
}: {
  name: string
  target: string
  isReadOnly: boolean
  isConfig: boolean
  /** Absent where this caller cannot make the switch. */
  onTurnIntoPolicy?: () => void
  onSave: (target: string) => void
  isPending: boolean
  error?: unknown
}) {
  const [next, setNext] = useState(target)
  const isSyncing = useRoutingSyncing()
  const isDirty = next.trim() !== target

  return (
    <div className="flex flex-col gap-6">
      <section
        aria-label="Points to"
        className="flex max-w-[40rem] flex-col gap-2"
      >
        {isReadOnly ? (
          <>
            <h2 className="text-title">Points to</h2>
            <p className="text-body">{selectorText(target)}</p>
          </>
        ) : (
          <OfferingPicker
            id="alias-target"
            label="Points to"
            value={next}
            onChange={setNext}
            isRequired
          />
        )}
      </section>
      <section aria-labelledby="alias-backups" className="flex flex-col gap-2">
        <h2 id="alias-backups" className="text-title">
          Backups
        </h2>
        <p className="text-caption">
          {isConfig
            ? "Set in config; backups need a policy in the deployment config."
            : onTurnIntoPolicy
              ? `An alias points to one model. To add backups, turn it into a policy with the same name; apps keep sending "${name}" and nothing else changes.`
              : "An alias points to one model. To add backups, delete it and create a policy with the same name."}
        </p>
        {onTurnIntoPolicy ? (
          <div>
            <Button variant="ghost" onPress={onTurnIntoPolicy}>
              <FiGitBranch aria-hidden />
              Turn into a policy
            </Button>
          </div>
        ) : null}
      </section>
      {isReadOnly ? null : (
        <SaveBar
          note={
            next.trim() === ""
              ? "Pick the model the alias points to."
              : "Takes effect within 30 seconds."
          }
          isDirty={isDirty}
          canSave={next.trim() !== "" && !isSyncing}
          isPending={isPending}
          error={error}
          onDiscard={() => setNext(target)}
          onSave={() => onSave(next.trim())}
        />
      )}
    </div>
  )
}
