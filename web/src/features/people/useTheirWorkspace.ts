import type { PersonRow } from "@/features/people/people"
import { useSelectedWorkspace } from "@/shared/hooks/SelectedWorkspace"

/**
 * Sessions and Requests list one workspace, so a link from a person's page
 * opens on one of theirs: `select` a workspace a row's usage is in, when the
 * caller is in it, and `selectTheirs` before a list of everything they did,
 * keeping the selected workspace when it is one of theirs.
 */
export function useTheirWorkspace(person: PersonRow): {
  select: (workspaceId: string | undefined) => void
  selectTheirs: () => void
} {
  const { selected, memberships, select } = useSelectedWorkspace()
  const isMine = (workspaceId: string) =>
    memberships.some((one) => one.workspace_id === workspaceId)
  const show = (workspaceId: string | undefined) => {
    if (workspaceId && workspaceId !== selected?.workspace_id) {
      if (isMine(workspaceId)) select(workspaceId)
    }
  }
  const theirs = (person.member.workspaces ?? []).map(
    (place) => place.workspace_id,
  )
  return {
    select: show,
    selectTheirs: () => {
      if (!selected || !theirs.includes(selected.workspace_id)) {
        show(theirs.find(isMine))
      }
    },
  }
}
