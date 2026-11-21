import type { ReactNode } from "react"
import { useState } from "react"
import { FiPlus } from "react-icons/fi"
import { Button } from "@/design-system/actions/Button"
import { ErrorBanner } from "@/design-system/feedback/ErrorBanner"
import { PageIntro } from "@/design-system/layout/PageIntro"
import { useIsOrganizationManager } from "@/features/organization/access"
import { NewRuleDialog } from "@/features/rules/NewRuleDialog"
import { RULE_TAB_LABEL, type RuleTab, ruleTabs } from "@/features/rules/rules"
import { ViewTabs } from "@/shared/components/ViewTabs"

/** The view a frame is over: a type of rule, or Routing. */
export type RulesView = RuleTab | "routing"

/**
 * The title over the list of rules (`RulesPage.tsx`, one tab per type) or the
 * routing policies (`features/routing/RoutingPage.tsx`, at `/routing`).
 * Routing has a rail row of its own, so it is titled Routing and carries no
 * rule tabs, and the rule tabs do not lead to it.
 */
export function RulesFrame({
  current,
  error,
  children,
}: {
  current: RulesView
  error?: unknown
  children: ReactNode
}) {
  const isManager = useIsOrganizationManager()
  const [isNewOpen, setNewOpen] = useState(false)
  const isRouting = current === "routing"

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="otari-rules-intro flex flex-col">
        <PageIntro
          title={isRouting ? "Routing" : "Rules"}
          action={
            // Routing's own Create policy is the action on that view.
            isManager && !isRouting ? (
              <Button variant="primary" onPress={() => setNewOpen(true)}>
                <FiPlus aria-hidden className="size-4" />
                New rule
              </Button>
            ) : undefined
          }
        />
        {error ? (
          <div className="pb-4">
            <ErrorBanner error={error} />
          </div>
        ) : null}
        {isRouting ? null : (
          <ViewTabs
            label="Rule types"
            current={current}
            tabs={ruleTabs(isManager).map((one) => ({
              id: one,
              to: "/rules",
              label: RULE_TAB_LABEL[one],
              search: one === "all" ? {} : { type: one },
            }))}
          />
        )}
      </div>
      {children}
      {isNewOpen ? <NewRuleDialog onClose={() => setNewOpen(false)} /> : null}
    </div>
  )
}
