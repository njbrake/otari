"""A workspace's saved views for a dashboard page: each person's own, and the shared ones."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from gateway.api.deps import CurrentIdentity, SavedViewServiceDep, verify_master_key
from gateway.api.routes.organizations import Message
from gateway.models.saved_views import SavedViewPage
from gateway.schemas.saved_views import SavedViewCreate, SavedViewPublic, SavedViewsPublic, SavedViewUpdate

router = APIRouter(
    prefix="/workspaces/{workspace_id}/saved-views",
    tags=["saved-views"],
    dependencies=[Depends(verify_master_key)],
)


@router.get("")
async def list_saved_views(
    workspace_id: uuid.UUID,
    service: SavedViewServiceDep,
    current_identity: CurrentIdentity,
    page: Annotated[SavedViewPage, Query(description="The dashboard page the views belong to.")],
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 200,
) -> SavedViewsPublic:
    """List the views the caller may open on a page: their own first, then those shared with the workspace."""
    return await service.list_views(user=current_identity, workspace_id=workspace_id, page=page, skip=skip, limit=limit)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_saved_view(
    workspace_id: uuid.UUID,
    service: SavedViewServiceDep,
    current_identity: CurrentIdentity,
    body: SavedViewCreate,
) -> SavedViewPublic:
    """Save a view. Sharing it with the workspace needs someone who manages the workspace."""
    return await service.create_view(user=current_identity, workspace_id=workspace_id, request=body)


@router.patch("/{view_id}")
async def update_saved_view(
    workspace_id: uuid.UUID,
    view_id: uuid.UUID,
    service: SavedViewServiceDep,
    current_identity: CurrentIdentity,
    body: SavedViewUpdate,
) -> SavedViewPublic:
    """Rename, re-save or re-share one of the caller's own views."""
    return await service.update_view(user=current_identity, workspace_id=workspace_id, view_id=view_id, request=body)


@router.delete("/{view_id}")
async def delete_saved_view(
    workspace_id: uuid.UUID,
    view_id: uuid.UUID,
    service: SavedViewServiceDep,
    current_identity: CurrentIdentity,
) -> Message:
    """Delete one of the caller's views, or a shared one when they manage the workspace."""
    await service.delete_view(user=current_identity, workspace_id=workspace_id, view_id=view_id)
    return Message(message="Saved view deleted")
