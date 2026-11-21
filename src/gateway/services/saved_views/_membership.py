"""Removes a member's private saved views from a workspace as they leave it."""

import uuid
from collections.abc import Sequence

from gateway.models.tenancy import OrganizationMember, WorkspaceMember
from gateway.repositories.saved_views import SavedViewRepository


class SavedViewMembershipListener:
    """Removes a person's private views from a workspace once they can no longer see it, inside the caller's block.

    A private view nobody else can open is not kept for a return that may never
    come. A shared one stays shared: the workspace still reads it, and its
    managers keep it while its owner is gone, which gives it back to the owner
    should they return.
    """

    def __init__(self, views: SavedViewRepository) -> None:
        self._views = views

    async def member_joined(self, member: WorkspaceMember) -> None:
        """Nothing: a joining member starts from the built-in and shared views."""

    async def member_removed(self, member: WorkspaceMember) -> None:
        """Remove the private views the member saved in the workspace."""
        await self._views.remove_private_in(member.user_id, [member.workspace_id])

    async def member_role_changed(self, member: WorkspaceMember) -> None:
        """Nothing: a shared view stays, and changing it again needs the role back."""

    async def organization_member_changed(
        self, membership: OrganizationMember, workspace_ids: Sequence[uuid.UUID]
    ) -> None:
        """Nothing here: the workspaces a person lost are what removes their views."""

    async def workspace_deleted(self, workspace_id: uuid.UUID, member_ids: Sequence[uuid.UUID]) -> None:
        """Nothing: the workspace's views go with it."""

    async def member_lost_workspaces(self, user_id: uuid.UUID, workspace_ids: Sequence[uuid.UUID]) -> None:
        """Remove the private views the person saved in these workspaces."""
        await self._views.remove_private_in(user_id, workspace_ids)
