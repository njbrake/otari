"""A workspace's saved views for a dashboard page."""

import uuid
from collections.abc import Collection
from typing import Protocol

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
from gateway.services.saved_views._built_ins import BUILT_IN_VIEWS, BuiltInView
from gateway.services.saved_views._queries import require_page_keys


class WorkspaceChecks(Protocol):
    """The workspace visibility and management rules, as the organizations domain defines them."""

    async def resolve_visible_workspace(self, *, user: User, workspace_id: uuid.UUID) -> Workspace:
        """The workspace, or a not-found error when the caller may not see it."""
        ...

    async def has_workspace_management_access(self, *, user: User, workspace: Workspace) -> bool:
        """Whether the caller manages the workspace."""
        ...

    async def people(self, user_ids: Collection[uuid.UUID]) -> list[User]:
        """The accounts these ids name."""
        ...


def _built_in(page: SavedViewPage, view: BuiltInView) -> SavedViewPublic:
    return SavedViewPublic(
        id=f"built-in:{view.slug}",
        page=page,
        name=view.name,
        query=view.query,
        built_in=True,
        shared=False,
        is_mine=False,
        owner_name=None,
        can_edit=False,
        can_delete=False,
        updated_at=None,
    )


def _display_name(person: User | None) -> str | None:
    if person is None:
        return None
    return person.full_name or person.email


class SavedViewService:
    """The saved-views domain's use cases. Each public method is one block of its Unit of Work.

    A view is visible to its owner and, once shared, to every member of its
    workspace; a workspace the caller cannot see is not found. Only its owner
    changes a view, and a shared one only while they manage the workspace; its
    owner or a workspace manager deletes a shared one; only a manager shares.
    """

    def __init__(self, uow: UnitOfWork, views: SavedViewRepository, workspaces: WorkspaceChecks) -> None:
        self._uow = uow
        self._views = views
        self._workspaces = workspaces

    async def list_views(self, *, user: User, workspace_id: uuid.UUID, page: SavedViewPage) -> SavedViewsPublic:
        """The views the caller may open on a page: the built-in ones, their own, then the workspace's shared ones."""
        async with self._uow:
            workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
            manages = await self._workspaces.has_workspace_management_access(user=user, workspace=workspace)
            rows = await self._views.list_visible(workspace_id=workspace.id, page=page.value, user_id=user.id)
            owners = {person.id: person for person in await self._workspaces.people({row.user_id for row in rows})}
            saved = [self._public(row, caller=user, manages=manages, owner=owners.get(row.user_id)) for row in rows]
        return SavedViewsPublic(
            data=[_built_in(page, view) for view in BUILT_IN_VIEWS[page]] + saved,
            can_share=manages,
        )

    async def create_view(self, *, user: User, workspace_id: uuid.UUID, request: SavedViewCreate) -> SavedViewPublic:
        """Save a view for the caller, shared with the workspace when they manage it and asked to."""
        require_page_keys(request.page, request.query)
        async with self._uow:
            workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
            manages = await self._workspaces.has_workspace_management_access(user=user, workspace=workspace)
            if request.shared and not manages:
                raise SavedViewSharingForbiddenError
            await self._views.lock_owned(workspace_id=workspace.id, page=request.page.value, user_id=user.id)
            owned = await self._views.count_owned(workspace_id=workspace.id, page=request.page.value, user_id=user.id)
            if owned >= MAX_VIEWS_PER_PAGE:
                raise SavedViewLimitReachedError(MAX_VIEWS_PER_PAGE)
            view = await self._views.add(
                user_id=user.id,
                workspace_id=workspace.id,
                page=request.page.value,
                name=request.name,
                query=request.query,
                shared=request.shared,
            )
            return self._public(view, caller=user, manages=manages, owner=user)

    async def update_view(
        self, *, user: User, workspace_id: uuid.UUID, view_id: uuid.UUID, request: SavedViewUpdate
    ) -> SavedViewPublic:
        """Rename, re-save, share or stop sharing one of the caller's views."""
        async with self._uow:
            workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
            view = await self._visible_view(user, workspace, view_id)
            if view.user_id != user.id:
                raise SavedViewNotYoursError
            changes = request.model_dump(exclude_none=True)
            if "query" in changes:
                require_page_keys(SavedViewPage(view.page), changes["query"])
            manages = await self._workspaces.has_workspace_management_access(user=user, workspace=workspace)
            # Checked against the view as it will be: someone who no longer manages
            # the workspace may stop sharing their view, not keep editing what everyone sees.
            if changes.get("shared", view.shared) and not manages:
                raise SavedViewSharingForbiddenError
            view = await self._views.update(view, changes)
            return self._public(view, caller=user, manages=manages, owner=user)

    async def delete_view(self, *, user: User, workspace_id: uuid.UUID, view_id: uuid.UUID) -> None:
        """Delete one of the caller's views, or a shared one when they manage the workspace."""
        async with self._uow:
            workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
            view = await self._visible_view(user, workspace, view_id)
            if view.user_id != user.id and not await self._workspaces.has_workspace_management_access(
                user=user, workspace=workspace
            ):
                raise SavedViewNotYoursError
            await self._views.delete(view)

    async def _visible_view(self, user: User, workspace: Workspace, view_id: uuid.UUID) -> SavedView:
        view = await self._views.get_visible(view_id=view_id, workspace_id=workspace.id, user_id=user.id)
        if view is None:
            raise SavedViewNotFoundError(view_id)
        return view

    @staticmethod
    def _public(view: SavedView, *, caller: User, manages: bool, owner: User | None) -> SavedViewPublic:
        is_mine = view.user_id == caller.id
        return SavedViewPublic(
            id=str(view.id),
            page=SavedViewPage(view.page),
            name=view.name,
            query=view.query,
            built_in=False,
            shared=view.shared,
            is_mine=is_mine,
            owner_name=_display_name(owner),
            can_edit=is_mine and (manages or not view.shared),
            can_delete=is_mine or (view.shared and manages),
            updated_at=view.updated_at,
        )
