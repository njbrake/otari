import { Link } from "@tanstack/react-router"
import { type ReactNode, useState } from "react"

import { Button } from "@/design-system/actions/Button"
import { TextButton } from "@/design-system/actions/TextButton"
import { CodeBlock } from "@/design-system/content/CodeBlock"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { Field } from "@/design-system/forms/Field"
import { SettingsGroup } from "@/design-system/layout/SettingsGroup"
import { DisclosureRow } from "@/design-system/navigation/DisclosureRow"
import { Segmented } from "@/design-system/navigation/Segmented"
import { describeOffering } from "@/features/models/offerings"
import { useRoutingSyncing, useUnpricedSelectors } from "@/shared/api/routing"
import { formatNumber } from "@/shared/helpers/format"

import { BACKUP_HELP } from "./BackupList"
import { GuardrailsSection } from "./GuardrailsSection"
import { ModelOrderList } from "./ModelOrderList"
import { selectorText, Warning } from "./PolicyCells"
import {
  buildSpec,
  isAtModelCap,
  isRouted,
  type PolicyDraft,
  parseWeights,
  poolProblems,
  poolShares,
  SELECTIONS,
  type Selection,
  saveProblem,
  selectionOf,
  switchSelection,
  triedInOrder,
  withTriedInOrder,
} from "./policyDraft"
import {
  KNN_BACKEND,
  MAX_CANDIDATES,
  PRIORITY_BACKEND,
  WEIGHTED_BACKEND,
} from "./policyModel"
import { RulesSection } from "./RulesSection"
import type { StepTraffic } from "./routingTraffic"
import { TierDownSection } from "./TierDownSection"
import { useGuardrailsConfigured } from "./useGuardrailsConfigured"

const SELECTION_HELP: Record<Selection, string> = {
  single:
    "Every request goes to one model. Backups are tried in order if it fails.",
  [WEIGHTED_BACKEND]: "Requests are shared across the pool by weight.",
  [KNN_BACKEND]:
    "Picks a model from the pool per request, from scored examples. Uses the default until it has enough.",
  [PRIORITY_BACKEND]:
    "Each request goes to the first model with room; the next takes over when one hits its rate limit.",
}

/** What else decides a routed pool's traffic, under the pool. */
const POOL_NOTE: Record<Exclude<Selection, "single">, ReactNode> = {
  [WEIGHTED_BACKEND]: (
    <>
      Shares are relative, so 70 and 30 mean the same as 7 and 3. The default
      serves a caller who sends <code>Otari-Router: off</code>.
    </>
  ),
  [PRIORITY_BACKEND]: (
    <>
      Only a model with a per-model limit ever fills; set one under{" "}
      <Link to="/settings" className="text-link hover:underline">
        Settings, Rate limit rules
      </Link>
      . The default serves a caller who sends <code>Otari-Router: off</code>.
    </>
  ),
  [KNN_BACKEND]: (
    <>
      The default serves whenever the router does not choose: too few scored
      examples, a weakly supported pick, a request carrying tools, or a caller
      sending <code>Otari-Router: off</code>. Open <b>Examples</b> on the
      policy's row in the list to watch it warm up.
    </>
  ),
}

/** What a share means, under its field. */
function shareHint(text: string, share: number): string {
  const value = parseWeights([text])[0] ?? Number.NaN
  if (!Number.isFinite(value) || value < 0) return "Zero or more"
  return value > 0
    ? `${Math.round(share)}% of requests`
    : "No traffic; still tried if another fails"
}

const AT_CAP = `A policy tries at most ${MAX_CANDIDATES} models, counting the backups.`

/** Move an entry of a list, for the parallel lists a pool keeps. */
function moved<T>(list: T[], from: number, to: number): T[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(to, 0, item)
  return next
}

/** What a step did in the last 30 days, or that a model the stored plan lacks has no history. */
function stepStat(
  step: StepTraffic | undefined,
  { isFirst }: { isFirst: boolean },
): string {
  if (step === undefined) return "New, no history"
  if (isFirst && step.failed > 0)
    return `${formatNumber(step.failed)} failed over (30d)`
  return step.served > 0
    ? `Served ${formatNumber(step.served)} (30d)`
    : "Not needed (30d)"
}

/**
 * A policy as one form: its main selection, its backups, and the folded
 * sections, saved together from one bar that stays in view.
 *
 * One draft rather than a Save per section, so a change that spans two (a
 * model moved from the pool to the backups) is one write, and the JSON below
 * shows exactly what Save sends. Read-only, the same layout without controls.
 */
export function PolicyEditor({
  stored,
  workspaceId,
  isAlias,
  isReadOnly,
  hasRules = false,
  ruleLabel = (id) => id,
  steps,
  nameIsDirty = false,
  nameProblem = "",
  onDiscard,
  onSave,
  saveNote,
  isPending,
  error,
}: {
  /** The policy as saved. Remount the editor (by key) to re-seed it. */
  stored: PolicyDraft
  /** Where the policy is stored, for the pricing check a Smart router needs. */
  workspaceId?: string
  isAlias: boolean
  isReadOnly: boolean
  /** Whether to show the rules, which send named members elsewhere. */
  hasRules?: boolean
  /** A member's name, for the rules summary. */
  ruleLabel?: (userId: string) => string
  /** What each step of the stored plan did in the last 30 days. */
  steps: ReadonlyMap<number, StepTraffic>
  /** A rename in the page's header, saved with the rest. */
  nameIsDirty?: boolean
  nameProblem?: string
  onDiscard: () => void
  onSave: (draft: PolicyDraft) => void
  /** What a save does, in the bar beside it. */
  saveNote: string
  isPending: boolean
  error?: unknown
}) {
  const [draft, setDraft] = useState(stored)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isSyncing = useRoutingSyncing()
  const isGuardrailsConfigured = useGuardrailsConfigured(!isReadOnly)
  const spec = buildSpec(draft)
  const isDirty =
    nameIsDirty || JSON.stringify(spec) !== JSON.stringify(buildSpec(stored))
  const selection = selectionOf(draft)
  // A Smart router scores by cost, so the server refuses a pool model with no
  // price. Asked as the pool changes, so the row says so before Save does.
  const needsPrices = selection === KNN_BACKEND && !isReadOnly
  const pricing = useUnpricedSelectors(
    workspaceId,
    draft.pool.models,
    needsPrices,
  )
  const unpriced = needsPrices
    ? (pricing.data?.unpriced ?? []).filter((selector) =>
        draft.pool.models.includes(selector),
      )
    : []
  const unpricedNames = unpriced
    .map((selector) => describeOffering(selector).model)
    .join(", ")
  const problem =
    nameProblem ||
    saveProblem(draft) ||
    (unpriced.length > 0
      ? `${unpricedNames} ${unpriced.length === 1 ? "has" : "have"} no price, and Smart router needs one for every pool model.`
      : "")
  const routed = isRouted(draft)
  const atCap = isAtModelCap(draft)
  const toggle = (section: string) =>
    setOpen((prev) => ({ ...prev, [section]: !prev[section] }))

  // Statistics follow the model, not the row: a step's numbers are for the
  // model the stored plan tried there, wherever it has been moved to since.
  const storedPlan = isRouted(stored)
    ? [...stored.pool.models, ...stored.backups]
    : triedInOrder(stored)
  const statOf = (selector: string) => {
    const position = storedPlan.indexOf(selector)
    if (position < 0) return "New, no history"
    // A pool's steps are whichever model the router ranked there, so only a
    // one-model plan and the backups have a model per position.
    if (isRouted(stored) && position < stored.pool.models.length) return null
    return stepStat(steps.get(position + 1), { isFirst: position === 0 })
  }

  const backupsList = (
    models: string[],
    setModels: (next: string[]) => void,
    offset: number,
  ) => (
    <ModelOrderList
      label={routed ? "Backups" : "Tried in order"}
      models={models}
      roleOf={(index) =>
        index + offset === 0 ? "MAIN" : `BACKUP ${index + offset}`
      }
      itemName={(index) =>
        index + offset === 0 ? "the main model" : `backup ${index + offset}`
      }
      statOf={statOf}
      onMove={
        isReadOnly
          ? undefined
          : (from, to) => setModels(moved(models, from, to))
      }
      onRemove={(index) => setModels(models.filter((_, i) => i !== index))}
      onPick={(index, selector) =>
        setModels(models.map((entry, i) => (i === index ? selector : entry)))
      }
      onAdd={isAlias ? undefined : () => setModels([...models, ""])}
      addLabel="Add a backup"
      canAdd={!atCap}
      addNote={AT_CAP}
      minRows={routed ? 0 : 1}
    />
  )

  const pool = draft.pool
  const shares = poolShares(pool)
  const setPool = (next: Partial<PolicyDraft["pool"]>) =>
    setDraft((prev) => ({ ...prev, pool: { ...prev.pool, ...next } }))

  const ruleSummary =
    draft.rules.length === 0
      ? "None"
      : draft.rules
          .map(
            (rule) =>
              `${rule.userIds.map(ruleLabel).join(", ") || "…"} → ${
                rule.target ? describeOffering(rule.target).model : "…"
              }`,
          )
          .join("; ")

  const tierSummary =
    draft.tierDowns.length === 0
      ? "Off"
      : [...draft.tierDowns]
          .sort((a, b) => a.threshold - b.threshold)
          .map(
            (tier) =>
              `${tier.threshold}% → ${tier.target ? selectorText(tier.target) : "…"}`,
          )
          .join(", ")

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="main-selection" className="flex flex-col gap-3">
        <h2 id="main-selection" className="text-title">
          Main selection
        </h2>
        {isReadOnly || isAlias ? (
          <p className="text-body">
            {SELECTIONS.find((option) => option.value === selection)?.label}
          </p>
        ) : (
          <Segmented
            label="How the main model is chosen"
            options={SELECTIONS.map((option) => ({ ...option }))}
            value={selection}
            onChange={(next) =>
              setDraft((prev) => switchSelection(prev, next as Selection))
            }
          />
        )}
        <p className="text-caption">
          {isAlias
            ? "An alias sends every request to one model, with no backups."
            : SELECTION_HELP[selection]}
        </p>

        {routed ? (
          <>
            <h3 className="text-emphasis">Pool</h3>
            <ModelOrderList
              label="Pool"
              models={pool.models}
              roleOf={(index) =>
                index === pool.safeIndex ? "DEFAULT" : "MODEL"
              }
              itemName={(index) => `pool model ${index + 1}`}
              statOf={(selector) =>
                unpriced.includes(selector) ? (
                  <Warning>No price set</Warning>
                ) : (
                  statOf(selector)
                )
              }
              extraOf={(index) =>
                pool.backend === WEIGHTED_BACKEND ? (
                  <div className="w-24">
                    <Field
                      label={`Share of pool model ${index + 1}`}
                      value={pool.weights[index] ?? ""}
                      onChange={(value) =>
                        setPool({
                          weights: pool.weights.map((weight, i) =>
                            i === index ? value : weight,
                          ),
                        })
                      }
                      description={shareHint(
                        pool.weights[index] ?? "",
                        shares[index] ?? 0,
                      )}
                      isDisabled={isReadOnly}
                    />
                  </div>
                ) : isReadOnly || index === pool.safeIndex ? null : (
                  <TextButton onPress={() => setPool({ safeIndex: index })}>
                    Make default
                  </TextButton>
                )
              }
              onMove={
                isReadOnly
                  ? undefined
                  : (from, to) =>
                      setPool({
                        models: moved(pool.models, from, to),
                        weights: moved(pool.weights, from, to),
                        safeIndex:
                          pool.safeIndex === from
                            ? to
                            : pool.safeIndex === to
                              ? from
                              : pool.safeIndex,
                      })
              }
              onRemove={(index) =>
                setPool({
                  models: pool.models.filter((_, i) => i !== index),
                  weights: pool.weights.filter((_, i) => i !== index),
                  safeIndex:
                    index < pool.safeIndex
                      ? pool.safeIndex - 1
                      : index === pool.safeIndex
                        ? 0
                        : pool.safeIndex,
                })
              }
              onPick={(index, selector) =>
                setPool({
                  models: pool.models.map((entry, i) =>
                    i === index ? selector : entry,
                  ),
                })
              }
              // Zero, so a model added to a split takes no traffic until given some.
              onAdd={() =>
                setPool({
                  models: [...pool.models, ""],
                  weights: [...pool.weights, "0"],
                })
              }
              addLabel="Add to pool"
              canAdd={!atCap}
              addNote={AT_CAP}
            />
            {isReadOnly ? null : <PoolProblems pool={pool} />}
            {unpriced.length > 0 ? (
              <p className="text-caption text-warning">
                Smart router compares prices, so every pool model needs one.{" "}
                {unpricedNames} {unpriced.length === 1 ? "has" : "have"} none.{" "}
                <Link
                  to="/organization/pricing"
                  className="text-link hover:underline"
                >
                  Set a price in Pricing
                </Link>
              </p>
            ) : null}
            {selection !== "single" ? (
              <p className="text-caption">{POOL_NOTE[selection]}</p>
            ) : null}
            <h3 className="text-emphasis">Backups</h3>
            <p className="text-caption">
              If the picked model fails, the rest of the pool is tried, then
              these in order.
            </p>
            {backupsList(
              draft.backups,
              (backups) => setDraft((prev) => ({ ...prev, backups })),
              1,
            )}
          </>
        ) : (
          <>
            <h3 className="text-emphasis">Tried in order</h3>
            {backupsList(
              triedInOrder(draft),
              (models) => setDraft((prev) => withTriedInOrder(prev, models)),
              0,
            )}
          </>
        )}
      </section>

      {isAlias || isReadOnly ? null : (
        <p className="text-caption">{BACKUP_HELP}</p>
      )}

      {isAlias ? null : (
        <SettingsGroup>
          {hasRules ? (
            <DisclosureRow
              label="Rules"
              trailing={<span className="text-caption">{ruleSummary}</span>}
              isOpen={open.rules ?? false}
              onToggle={() => toggle("rules")}
            >
              <div className="flex flex-col gap-3 p-4">
                <p className="text-caption">
                  Send specific members to a different model. Checked in order
                  before budget tiers; the first match wins. Everyone else gets
                  the main selection.
                </p>
                {isReadOnly ? (
                  <span className="text-body">{ruleSummary}</span>
                ) : (
                  <RulesSection
                    rules={draft.rules}
                    onChange={(rules) =>
                      setDraft((prev) => ({ ...prev, rules }))
                    }
                  />
                )}
              </div>
            </DisclosureRow>
          ) : null}
          <DisclosureRow
            label="Budget tier-down"
            trailing={<span className="text-caption">{tierSummary}</span>}
            isOpen={open.tiers ?? false}
            onToggle={() => toggle("tiers")}
          >
            <div className="flex flex-col gap-3 p-4">
              <p className="text-caption">
                Switch to a cheaper model once the caller has used part of their
                budget.
              </p>
              {isReadOnly ? (
                <span className="text-body">{tierSummary}</span>
              ) : (
                <TierDownSection
                  tierDowns={draft.tierDowns}
                  onChange={(tierDowns) =>
                    setDraft((prev) => ({ ...prev, tierDowns }))
                  }
                />
              )}
            </div>
          </DisclosureRow>
          {draft.guardrails.length > 0 || !isReadOnly ? (
            <DisclosureRow
              label="Guardrails"
              trailing={
                <span className="text-caption">
                  {draft.guardrails.length === 0
                    ? "None"
                    : draft.guardrails
                        .map((guardrail) => guardrail.profile)
                        .join(", ")}
                </span>
              }
              isOpen={open.guardrails ?? false}
              onToggle={() => toggle("guardrails")}
            >
              <div className="p-4">
                {isReadOnly ? (
                  <span className="text-body">
                    {draft.guardrails
                      .map(
                        (guardrail) =>
                          `${guardrail.profile} (${guardrail.mode})`,
                      )
                      .join(", ")}
                  </span>
                ) : (
                  <GuardrailsSection
                    guardrails={draft.guardrails}
                    onChange={(guardrails) =>
                      setDraft((prev) => ({ ...prev, guardrails }))
                    }
                    isConfigured={isGuardrailsConfigured}
                  />
                )}
              </div>
            </DisclosureRow>
          ) : null}
          <DisclosureRow
            label="As JSON"
            trailing={
              <span className="text-caption">
                {isDirty
                  ? "Includes unsaved changes"
                  : "Same shape as config.yml"}
              </span>
            }
            isOpen={open.json ?? false}
            onToggle={() => toggle("json")}
          >
            <div className="p-4">
              <CodeBlock label="json" value={JSON.stringify(spec, null, 2)} />
            </div>
          </DisclosureRow>
        </SettingsGroup>
      )}

      {isReadOnly ? null : (
        <SaveBar
          note={
            problem ? (
              <span className="text-warning">Can't save: {problem}</span>
            ) : (
              saveNote
            )
          }
          isDirty={isDirty}
          canSave={problem === "" && !isSyncing}
          isPending={isPending}
          error={error}
          onDiscard={() => {
            setDraft(stored)
            onDiscard()
          }}
          onSave={() => onSave(draft)}
        />
      )}
    </div>
  )
}

/**
 * The one Save for the whole policy, held at the foot of the view while the
 * page scrolls, so it is in reach from any section that changed.
 */
function SaveBar({
  note,
  isDirty,
  canSave,
  isPending,
  error,
  onDiscard,
  onSave,
}: {
  note: ReactNode
  isDirty: boolean
  canSave: boolean
  isPending: boolean
  error?: unknown
  onDiscard: () => void
  onSave: () => void
}) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-col gap-3 rounded-md border border-border bg-surface px-4 py-3">
      <ErrorBanner error={error} />
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-caption">{note}</p>
        <Button
          variant="ghost"
          isDisabled={!isDirty || isPending}
          onPress={onDiscard}
        >
          Discard
        </Button>
        <Button
          variant="primary"
          isDisabled={!isDirty || !canSave}
          isPending={isPending}
          onPress={onSave}
        >
          Save
        </Button>
      </div>
    </div>
  )
}

/** What is wrong with a pool, as it is edited. */
function PoolProblems({ pool }: { pool: PolicyDraft["pool"] }) {
  const problems = poolProblems(pool)
  const message = problems.isTooSmall
    ? "Add at least two models. One is not a routing decision."
    : problems.hasDuplicate
      ? "Name each model once."
      : problems.hasBadShare
        ? "Every share is a number of zero or more. Use 0 to drain a model without removing it."
        : problems.isSplitEmpty
          ? "Give at least one model a share above zero, or only the default ever serves."
          : ""
  return message ? <p className="text-caption text-danger">{message}</p> : null
}
