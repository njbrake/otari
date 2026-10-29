import { Button } from "@heroui/react"
import { Link, useNavigate } from "@tanstack/react-router"
import { useCallback, useMemo, useRef, useState } from "react"
import {
  FiCopy,
  FiEdit2,
  FiEye,
  FiList,
  FiLock,
  FiTrash2,
} from "react-icons/fi"

import type { ApiKey, NameTraffic } from "@/client"

import { CopyableValue } from "@/design-system/actions/CopyField"
import { RowAction, RowActionRow } from "@/design-system/actions/RowAction"
import { DataTable, type DataTableColumn } from "@/design-system/data/DataTable"
import { ConfirmDialog } from "@/design-system/feedback/ConfirmDialog"
import { EmptyState } from "@/design-system/feedback/EmptyState"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { TableScrollFrame } from "@/design-system/layout/TableScrollFrame"
import { DocsLink } from "@/design-system/navigation/DocsLink"
import { FilterSelect } from "@/design-system/navigation/FilterSelect"
import { useMemberAttributionLabels } from "@/features/organization/attribution"
import { RouterReadiness } from "@/features/routing/RouterReadiness"
import { useKeys } from "@/shared/api/apiKeys"
import {
  useAutomaticFallbacks,
  useCopyOrganizationRoutingPolicy,
  useDeleteAlias,
  useDeleteOrganizationAlias,
  useDeleteOrganizationRoutingPolicy,
  useDeleteRoutingPolicy,
  useRoutingTraffic,
} from "@/shared/api/routing"
import { docsSourceHref } from "@/shared/helpers/docs"
import { formatNumber } from "@/shared/helpers/format"
import { useUrlState, useUrlValue } from "@/shared/helpers/urlState"

import { AutomaticFallbacks } from "./AutomaticFallbacks"
import { CreatePolicyDialog } from "./CreatePolicyDialog"
import { SentByCell, TriedInOrderCell } from "./PolicyCells"
import type { Intent } from "./policyDraft"
import {
  findCandidates,
  findFallthroughTarget,
  findRouterBackend,
  isEditableInForm,
  KNN_BACKEND,
  type RoutingRow,
  rowKeyOf,
} from "./policyModel"
import { namesSent, trafficForRow } from "./routingTraffic"
import { useRoutingRows } from "./useRoutingRows"

const ROUTING_URL_DEFAULTS = { key: "" }
const NO_TRAFFIC: NameTraffic[] = []

/** A key's name, for a filter option or a Sent by cell. */
const keyLabel = (apiKey: ApiKey): string => apiKey.key_name ?? apiKey.id

export function RoutingPage() {
  const navigate = useNavigate()
  const {
    rows,
    isLoading: isListLoading,
    error,
    isOperator,
    canEdit,
    manages,
    ownerId,
    isOwn,
    canEditRow,
    canCreateOwn,
    writeWorkspaceId,
    isWorkspaceSettled,
  } = useRoutingRows()
  const deletePolicy = useDeleteRoutingPolicy()
  const deleteAlias = useDeleteAlias()
  const deleteOrgPolicy = useDeleteOrganizationRoutingPolicy()
  const deleteOrgAlias = useDeleteOrganizationAlias()
  const copyPolicy = useCopyOrganizationRoutingPolicy()
  // One key at a time, from the filter or a link from the Keys page.
  const url = useUrlState(ROUTING_URL_DEFAULTS)
  const keyFilter = url.get("key")
  const apiKeyIds = keyFilter ? [keyFilter] : []
  const traffic = useRoutingTraffic(
    writeWorkspaceId ?? undefined,
    apiKeyIds,
    isWorkspaceSettled,
  )
  const keys = useKeys(writeWorkspaceId ?? undefined, isWorkspaceSettled)
  const memberLabels = useMemberAttributionLabels()
  // Stable, like everything else the columns below are memoized on. The
  // traffic read names only keys the caller may see, so a miss is a key
  // deleted since.
  const keyLabelOf = useMemo(() => {
    const keyNames = new Map(
      (keys.data ?? []).map((apiKey) => [apiKey.id, keyLabel(apiKey)]),
    )
    return (apiKeyId: string) => keyNames.get(apiKeyId) ?? "Deleted key"
  }, [keys.data])
  // A deep link may pre-fill a new fallback with ?target=provider:model.
  const initialTarget = useUrlValue("target")
  const [adding, setAdding] = useState(initialTarget !== "")
  // Where the create dialog opens: a form, or the choice of one.
  const [startAt, setStartAt] = useState<Intent | undefined>(
    initialTarget === "" ? undefined : "fallback",
  )
  // Where focus goes when nothing else claims it: creating the first policy
  // unmounts the empty state whose button opened the dialog.
  const createButtonRef = useRef<HTMLButtonElement | null>(null)
  const [createCount, setCreateCount] = useState(0)
  const openCreate = (intent?: Intent) => {
    setStartAt(intent)
    setCreateCount((n) => n + 1)
    setAdding(true)
  }
  const closeCreate = () => setAdding(false)
  const [pendingDelete, setPendingDelete] = useState<RoutingRow>()
  // Readiness opens inline under its own row, next to the control that opened it.
  const [expanded, setExpanded] = useState<string>()
  const canCreate = canEdit || canCreateOwn
  // `adding` is seeded from ?target= before the membership context settles, so
  // the role is applied here: a caller who may not create gets the read-only page.
  const isAdding = adding && canCreate

  // Stable, because the columns below are memoized on it for DataTable.
  const openPolicy = useCallback(
    (row: RoutingRow) =>
      void navigate({
        to: "/routing/$name",
        params: { name: row.name },
        search: row.user_id ? { user: row.user_id } : {},
      }),
    [navigate],
  )

  // Stable so DataTable's row cache holds; see its docstring.
  const renderDetail = useCallback(
    (row: RoutingRow) => (
      <RouterReadiness
        policyName={row.name}
        candidates={findCandidates(row.spec)}
        defaultTarget={findFallthroughTarget(row.spec)}
        backend={findRouterBackend(row.spec) ?? KNN_BACKEND}
        scopedUserId={row.user_id ?? null}
        onClose={() => setExpanded(undefined)}
      />
    ),
    [],
  )

  const names = traffic.data?.names ?? NO_TRAFFIC
  // With a key chosen, the rows it sent; a name it never sent says nothing
  // about that key.
  const sent = namesSent(names)
  const shown = keyFilter ? rows.filter((row) => sent.has(row.name)) : rows
  const hasShared = (row: RoutingRow) =>
    rows.some((other) => other.name === row.name && !other.user_id)

  const columns = useMemo<DataTableColumn<RoutingRow>[]>(() => {
    const hasOwnVersion = (row: RoutingRow) =>
      rows.some((other) => other.name === row.name && isOwn(other))
    const hasShared = (row: RoutingRow) =>
      rows.some((other) => other.name === row.name && !other.user_id)
    const subtitleOf = (row: RoutingRow): string => {
      if (isOwn(row) && hasShared(row)) return "Your version of a shared policy"
      if (!manages && !row.user_id && hasOwnVersion(row))
        return "Using your version"
      return ""
    }
    const appliesTo = (row: RoutingRow) => {
      if (!row.user_id)
        return (
          <span className="text-sm text-muted">
            {row.source === "config"
              ? "Deployment"
              : "Everyone in this workspace"}
          </span>
        )
      if (isOwn(row))
        return <span className="text-sm text-foreground">You</span>
      const label = memberLabels.get(row.user_id)
      return label ? (
        <span className="text-sm text-foreground">{label}</span>
      ) : (
        <CopyableValue value={row.user_id} label="user id" />
      )
    }
    const base: DataTableColumn<RoutingRow>[] = [
      {
        id: "name",
        header: "Policy",
        isRowHeader: true,
        cell: (row) => {
          const subtitle = subtitleOf(row)
          return (
            <span className="flex flex-col gap-0.5">
              <CopyableValue value={row.name} label="policy name" />
              {row.source === "config" ? (
                <span className="flex items-center gap-1 text-caption">
                  <FiLock aria-hidden className="size-3 shrink-0" />
                  Set in deployment config
                </span>
              ) : subtitle ? (
                <span className="text-caption">{subtitle}</span>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "order",
        header: "Tried in order",
        cell: (row) => <TriedInOrderCell row={row} />,
      },
    ]
    // Managers read one list, so who each row is for is a column; a member's
    // two lists already say it.
    if (manages)
      base.push({ id: "scope", header: "Applies to", cell: appliesTo })
    base.push(
      {
        id: "sentBy",
        header: "Sent by",
        cell: (row) => (
          <SentByCell
            sentBy={trafficForRow(row, rows, names).sentBy}
            labelOf={keyLabelOf}
          />
        ),
      },
      {
        id: "requests",
        header: "Requests (30d)",
        cell: (row) => (
          <span className="text-sm tabular-nums text-muted">
            {formatNumber(trafficForRow(row, rows, names).requests)}
          </span>
        ),
      },
    )
    base.push({
      id: "actions",
      header: "",
      cell: (policy) => {
        // Teaching is data, not configuration, so it is offered even for a policy
        // defined in config.yml: an operator can score examples for a policy they
        // cannot edit here, and without this that policy could never route.
        // Operator-only, because the panel reads the deployment-wide
        // `/routing/status`; an em dash where a policy has nothing to learn.
        const readiness = !isOperator ? null : findRouterBackend(
            policy.spec,
          ) !== KNN_BACKEND ? (
          <span className="text-muted">—</span>
        ) : (
          <RowAction
            icon={FiList}
            label={expanded === rowKeyOf(policy) ? "Hide examples" : "Examples"}
            onPress={() =>
              setExpanded((current) =>
                current === rowKeyOf(policy) ? undefined : rowKeyOf(policy),
              )
            }
          />
        )
        const isEditable = canEditRow(policy)
        // A policy this dashboard cannot edit without loss opens read-only.
        const canOpenToEdit = isEditable && isEditableInForm(policy.spec)
        // A member's own copy of a shared policy, offered while they have none.
        const canCopy =
          canCreateOwn &&
          policy.kind === "policy" &&
          !policy.user_id &&
          !hasOwnVersion(policy)
        return (
          <RowActionRow>
            {readiness}
            {canCopy ? (
              <RowAction
                icon={FiCopy}
                label="Make my own version"
                onPress={() => {
                  const workspaceId = policy.workspace_id ?? writeWorkspaceId
                  if (workspaceId === null) return
                  copyPolicy.mutate(
                    { name: policy.name, workspace_id: workspaceId },
                    {
                      onSuccess: () =>
                        openPolicy({ ...policy, user_id: ownerId }),
                    },
                  )
                }}
              />
            ) : null}
            <RowAction
              icon={canOpenToEdit ? FiEdit2 : FiEye}
              label={canOpenToEdit ? "Edit" : "View"}
              onPress={() => openPolicy(policy)}
            />
            {isEditable ? (
              <RowAction
                icon={FiTrash2}
                label="Delete"
                onPress={() => setPendingDelete(policy)}
              />
            ) : null}
          </RowActionRow>
        )
      },
    })
    return base
  }, [
    canCreateOwn,
    canEditRow,
    copyPolicy,
    expanded,
    isOperator,
    isOwn,
    keyLabelOf,
    manages,
    memberLabels,
    names,
    openPolicy,
    ownerId,
    rows,
    writeWorkspaceId,
  ])

  // Which of the four delete surfaces a row goes to. Both name the workspace the
  // row lives in; the deployment-wide pair carries the user scope, the tenant
  // pair a member's own policy by their identity.
  const deleteWorkspaceFor = (row: RoutingRow) =>
    row.workspace_id ?? writeWorkspaceId
  const deleteMutationFor = (row: RoutingRow) =>
    isOperator
      ? row.kind === "alias"
        ? deleteAlias
        : deletePolicy
      : row.kind === "alias"
        ? deleteOrgAlias
        : deleteOrgPolicy
  // Resolved for the pending row alone, not as a chain over all four: a refusal
  // stays on its mutation until the next call, so reading every one of them
  // would report the last row's failure over this row's confirm.
  const pendingDeleteMutation = pendingDelete
    ? deleteMutationFor(pendingDelete)
    : undefined

  const keyOptions = [
    { value: "", label: "All keys" },
    ...(keys.data ?? []).map((apiKey) => ({
      value: apiKey.id,
      label: keyLabel(apiKey),
    })),
  ]

  const table = (ariaLabel: string, tableRows: RoutingRow[], empty: string) => (
    <TableScrollFrame className="otari-routing-table">
      <DataTable
        ariaLabel={ariaLabel}
        columns={columns}
        rows={tableRows}
        getRowKey={rowKeyOf}
        detailKey={expanded}
        renderDetail={renderDetail}
        isLoading={isListLoading}
        emptyContent={
          keyFilter
            ? "This key sent none of these names in the last 30 days."
            : empty
        }
      />
    </TableScrollFrame>
  )

  return (
    <div className="flex flex-col gap-6">
      <PageIntro
        title="Routing"
        action={
          canCreate ? (
            <Button
              ref={createButtonRef}
              // Visible while the dialog is open: the dialog is over the page,
              // so there is nothing for hiding this to prevent.
              variant="primary"
              onPress={() => openCreate()}
            >
              {canEdit ? "Create policy" : "New policy"}
            </Button>
          ) : undefined
        }
      >
        {/* Three readings of the same page, because what a caller may do here
            differs: an operator sees the deployment-wide capabilities, an
            admin sees what their own workspace writes reach, and a member
            sees their own policies beside the shared ones. */}
        Model names your callers send as{" "}
        <code className="font-mono text-caption">model</code>. Each policy picks
        the model that serves a request and the backups tried, in order, when it
        fails.{" "}
        {isOperator
          ? null
          : canEdit
            ? "What you create here applies in the selected workspace, and can name any model your organization has a provider key for."
            : canCreateOwn
              ? "Your own policies apply to your requests alone, and win over a shared one of the same name."
              : "These are the ones in force in your workspaces; your organization's admins manage them."}
      </PageIntro>

      {/* The reads, and the copy, which has no dialog of its own. Every delete
          on this page reports inside its own confirm dialog. */}
      <ErrorBanner error={error ?? copyPolicy.error} />

      {/* Mounted while closed so the frame plays its exit with the content
          intact, and keyed on the open counter so the draft is fresh on the way
          in rather than cleared on the way out. See feedback.md. */}
      <CreatePolicyDialog
        key={createCount}
        isOpen={isAdding}
        startAt={startAt}
        initialTarget={initialTarget}
        // The empty state's buttons are gone by the time this closes, since
        // creating one is what makes the page non-empty. The heading's action
        // survives.
        returnFocusRef={createButtonRef}
        isDeploymentWide={isOperator}
        workspaceId={writeWorkspaceId}
        memberId={canEdit ? "" : ownerId}
        onClose={closeCreate}
      />

      {rows.length > 0 && keyOptions.length > 1 ? (
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            ariaLabel="Sent by key"
            value={keyFilter}
            onChange={(next) => url.patch({ key: next })}
            options={keyOptions}
          />
        </div>
      ) : null}

      {rows.length === 0 && !isListLoading ? (
        canCreate ? (
          <EmptyState
            title="No routing policies yet"
            description={
              canEdit
                ? "A policy gives callers one model name with backups behind it, so a provider outage does not become a failed request."
                : "A policy of your own gives one model name backups behind it, for your requests alone."
            }
            actionLabel="Create fallback"
            onAction={() => openCreate("fallback")}
            secondaryActionLabel="Other policy types"
            onSecondaryAction={() => openCreate()}
          >
            <p className="max-w-prose text-caption">
              Tip: the same model on several providers already falls back
              automatically when callers send its catalog ID.{" "}
              <Link to="/models" className="text-link hover:underline">
                Browse models
              </Link>{" "}
              or{" "}
              <DocsLink href={docsSourceHref("models.md", "catalog-spellings")}>
                read how
              </DocsLink>
              .
            </p>
          </EmptyState>
        ) : (
          <EmptyState title="No routing policies yet">
            <p className="text-sm text-muted">
              Policies that apply in your workspaces will be listed here once
              your organization's admins define them.
            </p>
          </EmptyState>
        )
      ) : manages ? (
        table("Routing policies", shown, "No routing policies yet.")
      ) : (
        <>
          <section className="flex flex-col gap-3" aria-label="Your policies">
            <h2 className="text-title">Your policies</h2>
            {table(
              "Your policies",
              shown.filter(isOwn),
              canCreateOwn
                ? "None yet. Make your own version of a shared policy, or create a new one."
                : "None. This workspace's admins have turned off creating your own.",
            )}
          </section>
          <section className="flex flex-col gap-3" aria-label="Shared policies">
            <div className="flex flex-col gap-1">
              <h2 className="text-title">Shared policies</h2>
              <p className="text-caption">
                Set by your organization's admins for everyone in this
                workspace. Your own version of a name is used instead for your
                requests.
              </p>
            </div>
            {table(
              "Shared policies",
              shown.filter((row) => !isOwn(row)),
              "No shared policies in this workspace.",
            )}
          </section>
        </>
      )}

      <AutomaticFallbacksSection
        apiKeyIds={apiKeyIds}
        keyLabelOf={keyLabelOf}
      />

      <ConfirmDialog
        isOpen={pendingDelete !== undefined}
        // Cleared on the way out: a refusal otherwise sits on the mutation and
        // greets the next row's confirm as if that row had failed.
        onOpenChange={(open) => {
          if (open) return
          setPendingDelete(undefined)
          deletePolicy.reset()
          deleteAlias.reset()
          deleteOrgPolicy.reset()
          deleteOrgAlias.reset()
        }}
        heading={
          pendingDelete?.kind === "alias" ? "Delete alias" : "Delete policy"
        }
        body={
          pendingDelete
            ? pendingDelete.user_id && hasShared(pendingDelete)
              ? `${isOwn(pendingDelete) ? "Your" : "This person's"} requests that send ${pendingDelete.name} go back to the shared policy.`
              : `${pendingDelete.name} stops resolving. A request that still sends it as its model is refused, so update the callers that name it.`
            : null
        }
        confirmLabel={
          pendingDelete?.kind === "alias" ? "Delete alias" : "Delete policy"
        }
        isPending={pendingDeleteMutation?.isPending ?? false}
        error={pendingDeleteMutation?.error}
        onConfirm={() => {
          if (!pendingDelete) return
          const onSuccess = () => setPendingDelete(undefined)
          const rowWorkspace = deleteWorkspaceFor(pendingDelete)
          if (isOperator) {
            const deployment = {
              name: pendingDelete.name,
              userId: pendingDelete.user_id,
              workspaceId: rowWorkspace,
            }
            if (pendingDelete.kind === "alias")
              deleteAlias.mutate(deployment, { onSuccess })
            else deletePolicy.mutate(deployment, { onSuccess })
            return
          }
          // Unreachable: a stored row always carries its own workspace.
          if (rowWorkspace === null) return
          const scoped = { name: pendingDelete.name, workspaceId: rowWorkspace }
          if (pendingDelete.kind === "alias")
            deleteOrgAlias.mutate(scoped, { onSuccess })
          else
            deleteOrgPolicy.mutate(
              { ...scoped, memberId: pendingDelete.user_id ?? undefined },
              { onSuccess },
            )
        }}
      />
    </div>
  )
}

/**
 * The models callers used in the last 30 days, with the offerings their catalog
 * ID tries, who runs the built-in tools on each, and which keys sent it, as the
 * gateway reports them.
 */
function AutomaticFallbacksSection({
  apiKeyIds,
  keyLabelOf,
}: {
  apiKeyIds: readonly string[]
  keyLabelOf: (apiKeyId: string) => string
}) {
  const fallbacks = useAutomaticFallbacks(apiKeyIds)
  return (
    <AutomaticFallbacks
      fallbacks={fallbacks.data?.models ?? []}
      keyLabelOf={keyLabelOf}
      toolsNote="Tools shown for callers that declare them in the provider's own words and leave the choice to Otari: a provider's own where it runs them, Otari's where it does not."
      isLoading={fallbacks.isLoading}
      error={fallbacks.error}
    />
  )
}
