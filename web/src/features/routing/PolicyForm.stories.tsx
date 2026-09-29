import type { Meta, StoryObj } from "@storybook/react-vite"

import type { PolicySpec } from "@/client"
import { API_ROOT } from "@/shared/api/client"
import { organizationMember, user } from "@/tests/fixtures"

import { PolicyForm } from "./PolicyForm"

/**
 * The routing form, in the dialog every create and edit in the dashboard opens
 * in.
 *
 * It owns queries of its own (the model catalog behind both pickers, and the
 * scope picker's two reads), so these stories declare a stub gateway through `parameters.api` rather than
 * mocking the hooks.
 */
const CATALOG = {
  providers: [
    {
      provider: "openai",
      models: ["gpt-4o", "gpt-4o-mini", "o3-mini"].map((id) => ({
        id,
        key: `openai:${id}`,
      })),
      ok: true,
      discovery_unsupported: false,
      checked_at: "2026-09-10T12:00:00Z",
    },
    {
      provider: "anthropic",
      models: ["claude-sonnet-4-5", "claude-3-5-haiku-latest"].map((id) => ({
        id,
        key: `anthropic:${id}`,
      })),
      ok: true,
      discovery_unsupported: false,
      checked_at: "2026-09-10T12:00:00Z",
    },
  ],
}

/** The same catalog with one provider that could not be listed, which is what
 *  puts the picker's hint on screen: a sentence rather than a caption, and the
 *  state that used to lift a row's picker clear of the controls beside it. */
const CATALOG_WITH_A_FAILED_PROVIDER = {
  providers: [
    CATALOG.providers[0],
    { ...CATALOG.providers[1], models: [], ok: false },
  ],
}

/** Who the scope picker can name, and what the roster calls them.
 *
 *  Both halves of the labeling, so the scoped tab shows the real thing: one
 *  owner id the organization has a person behind, and one it does not.
 */
const OWNERS = [user({ user_id: "u-ana" }), user({ user_id: "release-bot" })]

const ROSTER = {
  data: [
    organizationMember({
      user_id: "u-ana",
      attribution_user_id: "u-ana",
      full_name: "Ana Ruiz",
      role: "member",
    }),
  ],
  count: 1,
}

const meta = {
  title: "Features/Routing/PolicyForm",
  component: PolicyForm,
  parameters: {
    layout: "fullscreen",
    api: {
      [`${API_ROOT}/models/discoverable`]: CATALOG,
      // The scope picker's two reads, which the form makes while it is open, so
      // without these the mock answers its deliberate 501 rather than the
      // network's 404.
      [`${API_ROOT}/users`]: OWNERS,
      [`${API_ROOT}/organizations/me/members`]: ROSTER,
    },
  },
  args: {
    existing: null,
    // The operator's surface, which is what the user-scope picker below needs.
    deploymentWide: true,
    workspaceId: null,
    onClose: () => {},
  },
} satisfies Meta<typeof PolicyForm>

export default meta

type Story = StoryObj<typeof meta>

/** A new policy, which is three fields until something more is asked for. */
export const New: Story = {}

/**
 * The longest policy this form can author, and the reason the routing dialog is
 * `lg` on both of its steps: a fallback chain, a condition tier, and the
 * weighted split that replaces the single target.
 *
 * This is the scrolling body in its real form rather than a demo one. The header
 * and the footer stay put, the body scrolls between them, and the header gains
 * its rule once content is under it.
 */
export const LongestPolicy: Story = {
  args: {
    existing: {
      kind: "policy" as const,
      name: "balanced",
      user_id: null,
      workspace_id: null,
      source: "api",
      is_dynamic: false,
      created_at: "2026-09-10T12:00:00Z",
      updated_at: "2026-09-10T12:00:00Z",
      // The spec is a `select` list, read in order, plus a shared failure
      // chain: a condition tier first, then the weighted split
      // that serves everything else.
      spec: {
        select: [
          {
            // The one condition the form models: tier down once the
            // owner's budget is most of the way spent.
            when: { budget_used_pct: { gte: 80 } },
            target: "anthropic:claude-3-5-haiku-latest",
          },
          {
            router: "weighted",
            candidates: ["openai:gpt-4o", "anthropic:claude-sonnet-4-5"],
            weights: { "openai:gpt-4o": 70, "anthropic:claude-sonnet-4-5": 30 },
          },
          // The fallthrough is its own entry and it is last, which is the shape
          // the form writes: an entry after the default can never be reached.
          { default: "openai:gpt-4o" },
        ],
        on_failure: ["anthropic:claude-sonnet-4-5", "openai:gpt-4o-mini"],
      } satisfies PolicySpec,
    },
  },
}

/**
 * The longest policy again, with a provider the gateway could not list.
 *
 * The hint that reports it is a sentence, so it wraps at this dialog's width.
 * It renders under each row rather than under the picker inside one, which is
 * what keeps every control in the row on one line; `web/design/forms.md`
 * ("Control rows") says why a field cannot hold it.
 */
export const CatalogPartlyUnavailable: Story = {
  ...LongestPolicy,
  parameters: {
    api: {
      [`${API_ROOT}/models/discoverable`]: CATALOG_WITH_A_FAILED_PROVIDER,
      [`${API_ROOT}/users`]: OWNERS,
      [`${API_ROOT}/organizations/me/members`]: ROSTER,
    },
  },
}
