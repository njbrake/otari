import { useState } from "react"

import type { DeploymentUser, MergeUserResponse } from "@/client"
import { FormDialog } from "@/design-system/feedback/FormDialog"
import { InfoBanner } from "@/design-system/feedback/InfoBanner"
import { UserComboBox } from "@/features/users/UserComboBox"
import { useMergeUser, useUsers } from "@/shared/api/users"
import { formatCount } from "@/shared/helpers/format"

import { accountLabel, mergedRowLines } from "./accounts"

/** What the preview found, or, after the merge, what moved. */
function MovedList({ result }: { result: MergeUserResponse }) {
  const lines = mergedRowLines(result.moved)
  if (lines.length === 0) {
    return (
      <p className="text-caption">
        {result.preview
          ? "Nothing names this record. Merging only retires it."
          : "Nothing named this record."}
      </p>
    )
  }
  return (
    <ul
      aria-label={result.preview ? "What moves" : "What moved"}
      className="flex flex-col gap-1 text-sm"
    >
      {lines.map((line) => (
        <li key={line.key} className="flex justify-between gap-4">
          <span>{line.label}</span>
          <span className="tabular-nums text-muted">
            {formatCount(line.count)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Fold an old user record into an account's own, from Accounts.
 *
 * For a person whose keys and usage were recorded under an id typed before they
 * signed in, beside the record their account bills through. Picking a record
 * previews the merge, which changes nothing, so the operator sees everything
 * that moves before confirming; the merge then moves it in one transaction and
 * retires the old record.
 */
export function MergeUserRecordDialog({
  account,
  onClose,
}: {
  /** The account whose record the other folds into; the dialog is closed while unset. */
  account: DeploymentUser | undefined
  onClose: () => void
}) {
  const isOpen = account !== undefined
  const users = useUsers(isOpen)
  const preview = useMergeUser()
  const merge = useMergeUser()
  const [source, setSource] = useState("")
  const name = account ? accountLabel(account) : ""
  const close = () => {
    setSource("")
    preview.reset()
    merge.reset()
    onClose()
  }
  const previewed =
    preview.data && preview.data.source_user_id === source
      ? preview.data
      : undefined

  if (account && merge.data) {
    return (
      <FormDialog
        isOpen
        onOpenChange={(open) => {
          if (!open) close()
        }}
        title="Records merged"
        submitLabel="Done"
        hideCancel
        onSubmit={close}
        isPending={false}
      >
        <InfoBanner>
          {merge.data.resumed ? (
            <>
              <code>{merge.data.source_user_id}</code> was already merged into{" "}
              <strong>{name}</strong>; what reached it since has moved too.
            </>
          ) : (
            <>
              <code>{merge.data.source_user_id}</code> is merged into{" "}
              <strong>{name}</strong> and retired.
            </>
          )}
        </InfoBanner>
        <MovedList result={merge.data} />
      </FormDialog>
    )
  }

  const candidates = (users.data ?? []).filter(
    (user) => user.user_id !== account?.id,
  )
  return (
    <FormDialog
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title="Merge user record"
      isDirty={source !== ""}
      submitLabel={previewed ? "Merge records" : "Show what moves"}
      isSubmitDisabled={source === ""}
      onSubmit={() => {
        if (!account || source === "") return
        if (previewed) {
          merge.mutate({
            id: account.id,
            body: { source_user_id: source, preview: false },
          })
        } else {
          preview.mutate({
            id: account.id,
            body: { source_user_id: source, preview: true },
          })
        }
      }}
      isPending={preview.isPending || merge.isPending}
      error={merge.error ?? preview.error}
    >
      <p className="text-body">
        Move everything recorded under another user id onto{" "}
        <strong>{name}</strong>: its keys, usage history, personal aliases and
        policies, files and traces. The other record is then retired. {name}{" "}
        keeps its own budget, model access and spend counters; the moved usage
        rows carry the other record's history.
      </p>
      <UserComboBox
        label="Record to merge in"
        placeholder="Pick a user, or type its id…"
        value={source}
        onChange={(next) => {
          setSource(next)
          preview.reset()
        }}
        users={candidates}
        description="Its rows move onto this account."
        unknownHint="No user has this id, so the merge would be refused."
        isRequired
      />
      {previewed ? (
        <div className="flex flex-col gap-2">
          <p className="text-overline">What moves</p>
          {previewed.resumed ? (
            <InfoBanner>
              This record was already merged into {name}. What is listed reached
              it since, and merging again moves it.
            </InfoBanner>
          ) : null}
          <MovedList result={previewed} />
          <p className="text-caption">
            This cannot be undone: once merged, the rows cannot be told apart
            from {name}'s own.
          </p>
        </div>
      ) : null}
    </FormDialog>
  )
}
