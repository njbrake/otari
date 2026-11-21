"""A workspace's saved views for a dashboard page: the page's own, each person's, and the shared ones.

A workspace the caller cannot see is not found, and so is another person's
private view, so neither id is an existence oracle.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from gateway.api.deps import CurrentIdentity, SavedViewServiceDep, verify_master_key
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
    identity: CurrentIdentity,
    page: Annotated[SavedViewPage, Query(description="The dashboard page the views belong to.")],
) -> SavedViewsPublic:
    """List the views the caller may open on a page: the built-in ones, their own, then the workspace's shared ones."""
    return await service.list_views(user=identity, workspace_id=workspace_id, page=page)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_saved_view(
    workspace_id: uuid.UUID, body: SavedViewCreate, service: SavedViewServiceDep, identity: CurrentIdentity
) -> SavedViewPublic:
    """Save a view. Sharing it with the workspace takes someone who manages the workspace."""
    return await service.create_view(user=identity, workspace_id=workspace_id, request=body)


@router.patch("/{view_id}")
async def update_saved_view(
    workspace_id: uuid.UUID,
    view_id: uuid.UUID,
    body: SavedViewUpdate,
    service: SavedViewServiceDep,
    identity: CurrentIdentity,
) -> SavedViewPublic:
    """Rename, re-save or re-share one of the caller's own views."""
    return await service.update_view(user=identity, workspace_id=workspace_id, view_id=view_id, request=body)


@router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_saved_view(
    workspace_id: uuid.UUID, view_id: uuid.UUID, service: SavedViewServiceDep, identity: CurrentIdentity
) -> Response:
    """Delete one of the caller's views, or a shared one when they manage the workspace."""
    await service.delete_view(user=identity, workspace_id=workspace_id, view_id=view_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
