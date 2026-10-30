import { FiPlus, FiX } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { MultiSelect } from "@/design-system/forms/MultiSelect"
import { OfferingPicker } from "@/features/models/OfferingPicker"
import { useMemberAttributionLabels } from "@/features/organization/attribution"

import type { UserRule } from "./policyDraft"

/**
 * Named members sent to another model: each rule is checked in order before
 * the budget tiers, the first match wins, and everyone else gets the main
 * selection.
 *
 * Members are offered from the organization's roster by the id their keys bill
 * to. An id in a stored rule that the roster no longer names (someone who left)
 * stays listed under its id, so saving does not quietly drop it.
 */
export function RulesSection({
  rules,
  onChange,
}: {
  rules: UserRule[]
  onChange: (next: UserRule[]) => void
}) {
  const labels = useMemberAttributionLabels()
  const named = rules.flatMap((rule) => rule.userIds)
  const options = [
    ...[...labels].map(([id, label]) => ({ id, label })),
    ...[...new Set(named)]
      .filter((id) => !labels.has(id))
      .map((id) => ({ id, label: id })),
  ]
  const update = (index: number, patch: Partial<UserRule>) =>
    onChange(
      rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)),
    )

  return (
    <div className="flex flex-col gap-3">
      {rules.map((rule, index) => (
        <div key={index} className="flex flex-wrap items-start gap-3">
          <span className="mt-8 w-14 shrink-0 text-mono-overline text-subtle">
            RULE {index + 1}
          </span>
          <div className="min-w-56 flex-1">
            <MultiSelect
              label="Members"
              options={options}
              value={rule.userIds}
              onChange={(userIds) => update(index, { userIds })}
              searchPlaceholder="Add a member…"
              countNoun={{ one: "member", other: "members" }}
              emptyMessage="Nobody in the organization to pick yet."
              noMatchesMessage="Nobody matches what you typed."
            />
          </div>
          <div className="min-w-56 flex-1">
            <OfferingPicker
              id={`rule-${index}`}
              label="Use"
              value={rule.target}
              onChange={(target) => update(index, { target })}
              isRequired
            />
          </div>
          <span className="mt-6">
            <IconButton
              variant="ghost"
              isIconOnly
              label={`Remove rule ${index + 1}`}
              onPress={() => onChange(rules.filter((_, i) => i !== index))}
            >
              <FiX aria-hidden />
            </IconButton>
          </span>
        </div>
      ))}
      <div>
        <Button
          variant="ghost"
          onPress={() => onChange([...rules, { userIds: [], target: "" }])}
        >
          <FiPlus aria-hidden />
          {rules.length === 0 ? "Add a rule" : "Add another rule"}
        </Button>
      </div>
    </div>
  )
}
