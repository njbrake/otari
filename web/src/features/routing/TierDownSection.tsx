import { FiPlus, FiTrash2 } from "react-icons/fi"

import { Button } from "@/design-system/actions/Button"
import { IconButton } from "@/design-system/actions/IconButton"
import { Field } from "@/design-system/forms/Field"
import { FieldAction } from "@/design-system/forms/FieldAction"
import { ControlField } from "@/design-system/forms/FieldMessages"
import { ModelComboBox } from "@/features/models/ModelComboBox"

import type { TierDown } from "./policyDraft"
import { SectionRow } from "./SectionRow"

/** The cheaper models a policy switches to as its budget fills. */
export function TierDownSection({
  tierDowns,
  onChange,
}: {
  tierDowns: TierDown[]
  onChange: (next: TierDown[]) => void
}) {
  const update = (index: number, patch: Partial<TierDown>) =>
    onChange(
      tierDowns.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)),
    )

  return (
    <div className="flex flex-col gap-3">
      <ControlField
        label="When the budget fills up, use instead"
        description="Checked before the main model. A threshold must be under 100: the budget gate refuses a request before selection once the cap is reached, so a rule at 100 could never fire."
      />
      {tierDowns.length === 0 ? (
        <p className="text-caption">
          No tier-down. The main model serves however much of the budget is
          used.
        </p>
      ) : null}
      {tierDowns.map((tier, index) => (
        <SectionRow
          key={index}
          id={`tier-hint-${index}`}
          modelValue={tier.target}
        >
          <Field
            label="Budget used at least (%)"
            value={String(tier.threshold)}
            onChange={(value) =>
              update(index, { threshold: Number(value) || 0 })
            }
            description={
              tier.threshold >= 100 ? (
                <span className="text-danger">Must be under 100.</span>
              ) : tier.threshold <= 0 ? (
                // A cleared box coerces to 0, which blocks the save; this says why.
                <span className="text-danger">Must be over 0.</span>
              ) : undefined
            }
          />
          <div className="min-w-56 flex-1">
            <ModelComboBox
              source="catalog"
              label="Use instead"
              value={tier.target}
              onChange={(value) => update(index, { target: value })}
              hintPlacement="detached"
              describedBy={`tier-hint-${index}`}
              isRequired
            />
          </div>
          <FieldAction>
            <IconButton
              variant="ghost"
              isIconOnly
              label={`Remove tier-down ${index + 1}`}
              onPress={() => onChange(tierDowns.filter((_, i) => i !== index))}
            >
              <FiTrash2 aria-hidden />
            </IconButton>
          </FieldAction>
        </SectionRow>
      ))}
      {/* Several, saved highest threshold first (`buildSpec`), so each one
          is reachable however they were entered. */}
      <div>
        <Button
          variant="ghost"
          onPress={() =>
            onChange([
              ...tierDowns,
              {
                threshold: Math.min(
                  95,
                  Math.max(80, ...tierDowns.map((tier) => tier.threshold + 5)),
                ),
                target: "",
              },
            ])
          }
        >
          <FiPlus aria-hidden />
          {tierDowns.length === 0 ? "Add a tier" : "Add another tier"}
        </Button>
      </div>
    </div>
  )
}
