import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { FiEdit2, FiLock } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { ConfirmDialog } from "@/design-system/feedback/ConfirmDialog"
import { EmptyState } from "@/design-system/feedback/EmptyState"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { InfoBanner } from "@/design-system/feedback/InfoBanner"
import { PageLoading } from "@/design-system/feedback/PageLoading"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { useKeys } from "@/shared/api/apiKeys"
import {
  useCopyOrganizationRoutingPolicy,
  useRoutingTraffic,
} from "@/shared/api/routing"
import { formatNumber } from "@/shared/helpers/format"
import { useUrlValue } from "@/shared/helpers/urlState"

import { PolicyEditor } from "./PolicyEditor"
import { nameProblemOf, PolicyNameField } from "./PolicyNameField"
import { PolicyReadOnly } from "./PolicyReadOnly"
import { buildSpec, draftFromSpec } from "./policyDraft"
import { isEditableInForm, type RoutingRow, rowKeyOf } from "./policyModel"
import { trafficForRow } from "./routingTraffic"
import { usePolicyDelete } from "./usePolicyDelete"
import { usePolicyWrite } from "./usePolicyWrite"
import { useRoutingRows } from "./useRoutingRows"

/**
 * One policy: who it applies to, what it tried in the last 30 days, and the
 * whole of it as one form with one Save.
 *
 * Takes the name as a prop and reads the scope from `?user=`, since the same
 * name can exist once for a workspace and once per member.
 */
export function PolicyDetailPage({ name }: { name: string }) {
  const userId = useUrlValue("user")
  const {
    rows,
    isLoading,
    isFetching,
    error,
    isOperator,
    manages,
    canEditRow,
    canCreateOwn,
    isOwn,
    ownerId,
    writeWorkspaceId,
    isWorkspaceSettled,
  } = useRoutingRows()
  const row = rows.find(
    (entry) => entry.name === name && (entry.user_id ?? "") === userId,
  )
  const traffic = useRoutingTraffic(
    writeWorkspaceId ?? undefined,
    [],
    isWorkspaceSettled,
  )

  const back = (
    <nav aria-label="Breadcrumb" className="text-caption">
      <Link to="/routing" className="text-link hover:text-link-hover">
        Routing
      </Link>{" "}
      / {name}
    </nav>
  )

  if (row === undefined) {
    if (isLoading || isFetching) return <PageLoading label="Loading policy…" />
    return (
      <div className="flex flex-col gap-6">
        {back}
        <ErrorBanner error={error} />
        {error ? null : (
          <EmptyState
            title="Policy not found"
            description="It may have been renamed or deleted, or it belongs to another workspace."
          />
        )}
      </div>
    )
  }

  const shared = rows.find((entry) => entry.name === row.name && !entry.user_id)
  const ownVersion = rows.find(
    (entry) => entry.name === row.name && isOwn(entry),
  )
  return (
    <div className="flex flex-col gap-6">
      {back}
      <ErrorBanner error={error} />
      {/* Keyed on the row, so moving to another policy starts a fresh form. */}
      <PolicyView
        key={rowKeyOf(row)}
        row={row}
        isOperator={isOperator}
        manages={manages}
        canEdit={canEditRow(row)}
        isOwn={isOwn(row)}
        isOwnVersion={isOwn(row) && shared !== undefined}
        // A member reading a shared policy they could make their own of.
        canCopy={
          canCreateOwn &&
          !row.user_id &&
          row.kind === "policy" &&
          ownVersion === undefined
        }
        ownVersion={row.user_id ? undefined : ownVersion}
        ownerId={ownerId}
        writeWorkspaceId={writeWorkspaceId}
        traffic={trafficForRow(row, rows, traffic.data?.names ?? [])}
      />
    </div>
  )
}

function PolicyView({
  row,
  isOperator,
  manages,
  canEdit,
  isOwn,
  isOwnVersion,
  canCopy,
  ownVersion,
  ownerId,
  writeWorkspaceId,
  traffic,
}: {
  row: RoutingRow
  isOperator: boolean
  /** An owner, admin or operator, who sees and writes a policy's rules. */
  manages: boolean
  canEdit: boolean
  isOwn: boolean
  /** The caller's own copy of a shared policy, which keeps its name. */
  isOwnVersion: boolean
  canCopy: boolean
  /** The caller's own version of this shared policy, when they have one. */
  ownVersion: RoutingRow | undefined
  ownerId: string
  writeWorkspaceId: string | null
  traffic: ReturnType<typeof trafficForRow>
}) {
  const navigate = useNavigate()
  const writer = usePolicyWrite(row, {
    isDeploymentWide: isOperator,
    fallbackWorkspaceId: writeWorkspaceId,
  })
  const deletes = usePolicyDelete({
    isOperator,
    fallbackWorkspaceId: writeWorkspaceId,
  })
  const copy = useCopyOrganizationRoutingPolicy()
  const keys = useKeys(writeWorkspaceId ?? undefined)
  const memberLabels = useMemberAttributionLabels()
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [nextName, setNextName] = useState(row.name)

  const isConfig = row.source === "config"
  const isRepresentable = isEditableInForm(row.spec)
  const isEditable = canEdit && isRepresentable
  // A copy keeps the shared name, and the alias API has no rename.
  const canRename = isEditable && !isOwnVersion && row.kind === "policy"
  const stored = draftFromSpec(row.spec)
  const nameProblem = isRenaming ? nameProblemOf(nextName, row.name) : ""
  const renamed = nextName.trim() !== "" && nextName.trim() !== row.name

  const openRow = (target: string, user: string) =>
    void navigate({
      to: "/routing/$name",
      params: { name: target },
      search: user ? { user } : {},
      replace: true,
    })

  const topKey = traffic.sentBy[0]
  const topKeyName = topKey
    ? (keys.data?.find((apiKey) => apiKey.id === topKey.apiKeyId)?.key_name ??
      "")
    : ""

  const appliesTo = isOwn
    ? {
        label: "Just you",
        help: "Only requests made with your keys. Nobody else is affected.",
      }
    : row.user_id
      ? {
          label: memberLabels.get(row.user_id) ?? row.user_id,
          help: "Only requests made with their keys. Everyone else gets the shared policy of this name.",
        }
      : isConfig
        ? {
            label: "Deployment",
            help: "Every workspace on this deployment, unless a workspace or member has its own of this name.",
          }
        : {
            label: "Everyone in this workspace",
            help: canEdit
              ? "Everyone in this workspace who sends this name. To change who it applies to, make a new policy."
              : "Everyone in this workspace who sends this name.",
          }

  const deleteLabel = isOwnVersion ? "Remove my version" : "Delete policy"
  const deleting = deletes.mutationFor(row)

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-display">
              {isOwnVersion ? `Your version of ${row.name}` : row.name}
            </h1>
            {canRename && !isRenaming ? (
              <IconButton
                variant="ghost"
                isIconOnly
                label="Rename"
                onPress={() => setIsRenaming(true)}
              >
                <FiEdit2 aria-hidden />
              </IconButton>
            ) : null}
          </div>
          <p className="text-body">
            Send{" "}
            <code className="font-mono text-caption">
              "model": "{row.name}"
            </code>{" "}
            to use it.{" "}
            {traffic.requests > 0
              ? `${formatNumber(traffic.requests)} requests in 30 days${
                  topKeyName ? `, most from ${topKeyName}` : ""
                }.`
              : "No requests in 30 days."}
          </p>
          {isOwnVersion ? (
            <p className="text-caption">
              Keeps the name {row.name} so it replaces the shared one for you.
              To use a different name, make a new policy.
            </p>
          ) : null}
        </div>
        {canEdit ? (
          <Button variant="danger" onPress={() => setIsConfirmingDelete(true)}>
            {deleteLabel}
          </Button>
        ) : null}
      </header>

      {isRenaming ? (
        <div className="max-w-[40rem]">
          <PolicyNameField
            value={nextName}
            onChange={setNextName}
            previousName={row.name}
            autoFocus
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 border-y border-border py-3">
        <span className="text-caption">Applies to</span>
        <span className="text-body text-foreground">{appliesTo.label}</span>
        <span className="text-caption">{appliesTo.help}</span>
      </div>

      {isConfig ? (
        <InfoBanner>
          <span className="flex items-center gap-2">
            <FiLock aria-hidden className="shrink-0" />
            Set in the deployment's config.yml, so it is read-only here.
          </span>
        </InfoBanner>
      ) : !isRepresentable ? (
        <InfoBanner>
          Uses options this page cannot show yet. Edit it through the API so
          nothing is lost.
        </InfoBanner>
      ) : null}
      {canCopy ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-4 py-3">
          <p className="min-w-0 flex-1 text-caption">
            Shared policy, managed by your admins. Make your own version to
            change it for your requests only.
          </p>
          <Button
            variant="ghost"
            isPending={copy.isPending}
            onPress={() => {
              const workspaceId = row.workspace_id ?? writeWorkspaceId
              if (workspaceId === null) return
              copy.mutate(
                { name: row.name, workspace_id: workspaceId },
                { onSuccess: () => openRow(row.name, ownerId) },
              )
            }}
          >
            Make my own version
          </Button>
        </div>
      ) : ownVersion ? (
        <InfoBanner>
          Your requests use{" "}
          <Link
            to="/routing/$name"
            params={{ name: row.name }}
            search={{ user: ownVersion.user_id ?? "" }}
            className="text-link hover:underline"
          >
            your own version
          </Link>{" "}
          of this policy.
        </InfoBanner>
      ) : !canEdit && !isConfig && !row.user_id ? (
        <InfoBanner>Your organization's admins manage this policy.</InfoBanner>
      ) : null}
      <ErrorBanner error={copy.error} />

      {!isRepresentable ? (
        <PolicyReadOnly row={row} />
      ) : (
        <PolicyEditor
          // Re-seeded when the stored policy changes, as after a save.
          key={JSON.stringify(row.spec)}
          stored={stored}
          workspaceId={row.workspace_id ?? writeWorkspaceId ?? undefined}
          isAlias={row.kind === "alias"}
          isReadOnly={!isEditable}
          // Managers only, since a rule names colleagues; and never on a
          // member's own policy, which applies to them alone.
          hasRules={manages && !row.user_id}
          ruleLabel={(id) => memberLabels.get(id) ?? id}
          steps={traffic.steps}
          nameIsDirty={isRenaming && renamed}
          nameProblem={nameProblem}
          onDiscard={() => {
            setNextName(row.name)
            setIsRenaming(false)
          }}
          saveNote="Takes effect within 30 seconds."
          isPending={writer.isPending}
          error={writer.error}
          onSave={(draft) => {
            const name = isRenaming && renamed ? nextName.trim() : row.name
            writer.write(buildSpec(draft), {
              name,
              onSuccess: () => {
                setIsRenaming(false)
                if (name !== row.name) openRow(name, row.user_id ?? "")
              },
            })
          }}
        />
      )}

      <ConfirmDialog
        isOpen={isConfirmingDelete}
        onOpenChange={(open) => {
          if (open) return
          setIsConfirmingDelete(false)
          deletes.reset()
        }}
        heading={deleteLabel}
        body={
          row.user_id
            ? `Requests that send ${row.name} go back to the shared policy of that name, or are refused if there is none.`
            : `${row.name} stops resolving. A request that still sends it as its model is refused, so update the callers that name it.`
        }
        confirmLabel={deleteLabel}
        isPending={deleting.isPending}
        error={deleting.error}
        onConfirm={() =>
          // Removing a version lands on the shared policy it stood in for.
          deletes.remove(row, () =>
            isOwnVersion
              ? openRow(row.name, "")
              : void navigate({ to: "/routing" }),
          )
        }
      />
    </>
  )
}
