import uuid

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.saved_views_exceptions import (
    SavedViewLimitReachedError,
    SavedViewNotFoundError,
    SavedViewNotYoursError,
    SavedViewSharingForbiddenError,
)
from gateway.models.saved_views import MAX_VIEWS_PER_PAGE, SavedView, SavedViewPage
from gateway.models.tenancy import User, Workspace
from gateway.repositories.saved_views import SavedViewRepository
from gateway.schemas.saved_views import SavedViewCreate, SavedViewPublic, SavedViewsPublic, SavedViewUpdate
from gateway.services.tenancy import WorkspaceService


class SavedViewService:
    """The saved-views domain's use cases. Each public method is one block of its Unit of Work.

    A view is visible to its owner and, once shared, to every member of its
    workspace; a workspace the caller cannot see is not found, as the other
    workspace-scoped reads have it. Only its owner changes a view, and only while
    they may share it if it is shared; its owner or someone who manages the
    workspace deletes a shared one; only someone who manages the workspace shares.
    """

    def __init__(self, uow: UnitOfWork, views: SavedViewRepository, workspaces: WorkspaceService) -> None:
        self._uow = uow
        self._views = views
        self._workspaces = workspaces

    async def list_views(
        self, *, user: User, workspace_id: uuid.UUID, page: SavedViewPage, skip: int = 0, limit: int = 200
    ) -> SavedViewsPublic:
        """Return a page of the views this person may open on a page: their own, then the workspace's shared ones."""
        async with self._uow:
            workspace = await self._workspaces.workspace_in_active_organization(user=user, workspace_id=workspace_id)
            rows = await self._views.list_visible(
                workspace_id=workspace.id, page=page, user_id=user.id, skip=skip, limit=limit
            )
            count = await self._views.count_visible(workspace_id=workspace.id, page=page, user_id=user.id)
            return SavedViewsPublic(
                data=[SavedViewPublic.from_model(view, owner_name=name, caller=user.id) for view, name in rows],
                count=count,
            )

    async def create_view(self, *, user: User, workspace_id: uuid.UUID, request: SavedViewCreate) -> SavedViewPublic:
        """Save a view for this person, shared with the workspace if they manage it and asked to."""
        async with self._uow:
            workspace = await self._workspaces.workspace_in_active_organization(user=user, workspace_id=workspace_id)
            if request.shared:
                await self._require_sharing(user, workspace)
            await self._views.lock_owned(workspace_id=workspace.id, page=request.page, user_id=user.id)
            owned = await self._views.count_owned(workspace_id=workspace.id, page=request.page, user_id=user.id)
            if owned >= MAX_VIEWS_PER_PAGE:
                raise SavedViewLimitReachedError(MAX_VIEWS_PER_PAGE)
            view = await self._views.add(SavedView(**request.model_dump(), user_id=user.id, workspace_id=workspace.id))
            return SavedViewPublic.from_model(view, owner_name=user.full_name, caller=user.id)

    async def update_view(
        self, *, user: User, workspace_id: uuid.UUID, view_id: uuid.UUID, request: SavedViewUpdate
    ) -> SavedViewPublic:
        """Rename, re-save, share or un-share one of this person's views."""
        async with self._uow:
            workspace = await self._workspaces.workspace_in_active_organization(user=user, workspace_id=workspace_id)
            view = await self._visible_view(user, workspace, view_id)
            if view.user_id != user.id:
                raise SavedViewNotYoursError
            changes = request.model_dump(exclude_none=True)
            # Checked against the view as it will be: someone who no longer manages the
            # workspace may un-share their view, but not keep editing what everyone sees.
            if changes.get("shared", view.shared):
                await self._require_sharing(user, workspace)
            view = await self._views.update(view, changes)
            return SavedViewPublic.from_model(view, owner_name=user.full_name, caller=user.id)

    async def delete_view(self, *, user: User, workspace_id: uuid.UUID, view_id: uuid.UUID) -> None:
        """Delete a view: the owner's own, or a shared one by someone who manages the workspace."""
        async with self._uow:
            workspace = await self._workspaces.workspace_in_active_organization(user=user, workspace_id=workspace_id)
            view = await self._visible_view(user, workspace, view_id)
            if view.user_id != user.id and not await self._workspaces.manages(user=user, workspace=workspace):
                raise SavedViewNotYoursError
            await self._views.delete(view)

    async def _visible_view(self, user: User, workspace: Workspace, view_id: uuid.UUID) -> SavedView:
        view = await self._views.get_visible(view_id=view_id, workspace_id=workspace.id, user_id=user.id)
        if view is None:
            raise SavedViewNotFoundError(view_id)
        return view

    async def _require_sharing(self, user: User, workspace: Workspace) -> None:
        if not await self._workspaces.manages(user=user, workspace=workspace):
            raise SavedViewSharingForbiddenError
