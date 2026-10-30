import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"

import { EmptyState } from "@/design-system/feedback/EmptyState"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { PageLoading } from "@/design-system/feedback/PageLoading"
import { Select } from "@/design-system/forms/Select"
import { Segmented } from "@/design-system/navigation/Segmented"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { useKeysById } from "@/shared/api/apiKeys"
import { useSetOrganizationRoutingPolicy } from "@/shared/api/routing"
import { useUrlValue } from "@/shared/helpers/urlState"
import { type NewPolicyScope, nameClash } from "./nameClash"
import { PolicyEditor } from "./PolicyEditor"
import { nameProblemOf, PolicyNameField } from "./PolicyNameField"
import { buildSpec, type PolicyDraft, seedDraft } from "./policyDraft"
import { useRoutingRows } from "./useRoutingRows"

type AppliesTo = "workspace" | "me" | "person"

const APPLIES_TO_HELP: Record<AppliesTo, string> = {
  workspace: "Everyone in this workspace who sends this name.",
  me: "Only requests made with your keys. Nobody else is affected.",
  person: "Only requests made with their keys. Nobody else is affected.",
}

/**
 * A new policy for an organization's workspace, as the same one-form editor a
 * policy opens in, with its name and who it applies to on top.
 *
 * `?key=` names the API key it is being set up for, which titles the page, and
 * `?target=` the model it starts from. A member's policy is their own; an owner
 * or admin picks the workspace, themselves or one member. The operator's create
 * stays the dialog on the list, which writes deployment-wide.
 */
export function NewPolicyPage() {
  const navigate = useNavigate()
  const keyId = useUrlValue("key")
  const target = useUrlValue("target")
  const {
    rows,
    isLoading,
    error,
    manages,
    canEdit,
    canCreateOwn,
    ownerId,
    writeWorkspaceId,
  } = useRoutingRows()
  const [forKey] = useKeysById(keyId ? [keyId] : [])
  const memberLabels = useMemberAttributionLabels()
  const save = useSetOrganizationRoutingPolicy()
  const [name, setName] = useState("")
  const [appliesTo, setAppliesTo] = useState<AppliesTo>("workspace")
  const [person, setPerson] = useState("")
  // Seeded once: the model a link starts from, as the main one.
  const [stored] = useState<PolicyDraft>(() => ({
    ...seedDraft("fallback", target),
    backups: [],
  }))

  const back = (
    <nav aria-label="Breadcrumb" className="text-caption">
      <Link to="/routing" className="text-link hover:text-link-hover">
        Routing
      </Link>{" "}
      / New policy
    </nav>
  )
  if (isLoading) return <PageLoading label="Loading routing…" />
  if (!canEdit && !canCreateOwn)
    return (
      <div className="flex flex-col gap-6">
        {back}
        <ErrorBanner error={error} />
        <EmptyState
          title="You can't create a policy here"
          description="This workspace's admins have turned off members creating their own policies, or no workspace is selected."
        />
      </div>
    )

  // A member's policy is always their own.
  const effective: AppliesTo = manages ? appliesTo : "me"
  const scope: NewPolicyScope =
    effective === "workspace"
      ? { kind: "workspace" }
      : effective === "me"
        ? { kind: "person", userId: ownerId, isCaller: true }
        : { kind: "person", userId: person, isCaller: false }
  const trimmed = name.trim()
  const nameProblem =
    trimmed === ""
      ? "Name the policy."
      : nameProblemOf(name) || nameClash(name, rows, scope)
  const personProblem =
    effective === "person" && person === ""
      ? "Pick the person it applies to."
      : ""
  const memberId =
    effective === "workspace" ? "" : effective === "me" ? ownerId : person

  return (
    <div className="flex flex-col gap-6">
      {back}
      <header className="flex flex-col gap-1">
        <h1 className="text-display">
          {forKey
            ? `Routing for ${forKey.key_name ?? forKey.id}`
            : "New policy"}
        </h1>
        <p className="text-body">
          Pick the model {forKey ? "this app uses" : "callers use"} and what to
          try if it fails. Then set {forKey ? "your app's" : "their"} model to{" "}
          <code className="font-mono text-caption">
            "{trimmed || "the name"}"
          </code>
          .
        </p>
      </header>
      <ErrorBanner error={error} />

      <div className="max-w-[40rem]">
        <PolicyNameField
          label="Policy name"
          value={name}
          onChange={setName}
          problem={trimmed === "" ? "" : nameClash(name, rows, scope)}
          autoFocus
        />
      </div>

      <div className="flex flex-col gap-3 border-y border-border py-3">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
          <span className="text-caption">Applies to</span>
          {manages ? (
            <Segmented
              label="Applies to"
              options={[
                { value: "workspace", label: "Everyone in this workspace" },
                { value: "me", label: "Just me" },
                { value: "person", label: "One person" },
              ]}
              value={appliesTo}
              onChange={(next) => setAppliesTo(next as AppliesTo)}
            />
          ) : (
            <span className="text-body text-foreground">Just you</span>
          )}
          <span className="text-caption">{APPLIES_TO_HELP[effective]}</span>
        </div>
        {effective === "person" ? (
          <div className="max-w-[24rem]">
            <Select
              label="Person"
              value={person}
              onChange={setPerson}
              placeholder="Pick a member"
              options={[...memberLabels]
                .filter(([id]) => id !== ownerId)
                .map(([id, label]) => ({ value: id, label }))}
              isRequired
            />
          </div>
        ) : null}
      </div>

      <PolicyEditor
        stored={stored}
        workspaceId={writeWorkspaceId ?? undefined}
        isReadOnly={false}
        hasRules={manages && effective === "workspace"}
        ruleLabel={(id) => memberLabels.get(id) ?? id}
        steps={new Map()}
        isUnsaved
        nameProblem={nameProblem || personProblem}
        saveNote={`Your app keeps working as it is until it sends "${
          trimmed || "the name"
        }". Takes effect within 30 seconds of saving.`}
        discardLabel="Cancel"
        saveLabel="Create policy"
        onDiscard={() => void navigate({ to: "/routing" })}
        isPending={save.isPending}
        error={save.error}
        onSave={(draft) => {
          if (writeWorkspaceId === null) return
          save.mutate(
            {
              name: trimmed,
              // Rules route other members, so only a workspace-wide policy keeps
              // them; switching who it applies to hides them, and this drops them.
              spec: buildSpec(
                effective === "workspace" ? draft : { ...draft, rules: [] },
              ),
              workspace_id: writeWorkspaceId,
              ...(memberId ? { member_id: memberId } : {}),
            },
            {
              onSuccess: () =>
                void navigate({
                  to: "/routing/$name",
                  params: { name: trimmed },
                  search: memberId ? { user: memberId } : {},
                }),
            },
          )
        }}
      />
    </div>
  )
}
