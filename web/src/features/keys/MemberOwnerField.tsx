import { useState } from "react"
import type { OrganizationMember } from "@/client"
import {
  ComboBoxField,
  type ComboBoxOption,
} from "@/design-system/forms/ComboBoxField"
import { memberLabel } from "@/features/organization/roles"

/**
 * The members an owner or admin may make a key for: every active member with
 * a sign-in identity, by that identity's id, which is what the organization's
 * key surface takes as `user_id`. An invitation, a suspended membership and a
 * row with no identity would be refused there, so none is offered.
 */
export function memberOwnerOptions(
  members: readonly OrganizationMember[],
): ComboBoxOption[] {
  return members
    .flatMap((member): ComboBoxOption[] =>
      member.status === "active" && member.user_id
        ? [
            {
              value: member.user_id,
              label: memberLabel(member),
              hint: member.full_name && member.email ? member.email : undefined,
            },
          ]
        : [],
    )
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The Owner of a key an organization owner or admin creates: a pick from the
 * organization's members, never a typed id, because the organization's key
 * surface refuses anyone who is not one.
 */
export function MemberOwnerField({
  value,
  onChange,
  members,
}: {
  /** The owner's identity id. */
  value: string
  onChange: (userId: string) => void
  members: readonly OrganizationMember[]
}) {
  const options = memberOwnerOptions(members)
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const visible = options
    .filter(
      (option) =>
        !q ||
        option.label.toLowerCase().includes(q) ||
        option.hint?.toLowerCase().includes(q),
    )
    .slice(0, 50)
  return (
    <ComboBoxField
      label="Owner"
      value={value}
      onChange={onChange}
      onQueryChange={setQuery}
      options={visible}
      description="The member this key acts for. Their access and limits apply, and its spend counts toward their budget. It is you unless you pick someone else."
      menuTrigger="focus"
      shouldSelectOnFocus
      isSourceEmpty={options.length === 0}
      emptyMessage="No members to pick from yet."
      noMatchesMessage="No member matches what you typed."
    />
  )
}
