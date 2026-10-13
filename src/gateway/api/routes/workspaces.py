"""Workspaces and workspace membership (standalone mode only).

Thin composition over `gateway.services.tenancy.workspace_service`. Every path
resolves its workspace inside the caller's active organization, so a workspace id
from another tenant answers 404 rather than reaching the service's logic.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from gateway.api.deps import CurrentIdentity, WorkspaceServiceDep, WorkspaceVisibilityServiceDep, verify_master_key
from gateway.api.routes.organizations import Message
from gateway.core.surface import Surface
from gateway.models.tenancy import (
    WorkspaceCreate,
    WorkspaceMemberPublic,
    WorkspaceMemberRole,
    WorkspaceMembersPublic,
    WorkspacePublic,
    WorkspacesPublic,
    WorkspaceUpdate,
)
from gateway.schemas.organizations import WorkspaceVisibility, WorkspaceVisibilityUpdate

# Auth is declared on the router, not left to arrive through `CurrentIdentity`:
# every handler here happens to take one today, and a future handler that did
# not would be unauthenticated with nothing to notice.
router = APIRouter(
    prefix="/workspaces",
    tags=["workspaces"],
    dependencies=[Depends(verify_master_key)],
)

SURFACE = Surface("workspaces")

WORKSPACE_ROLE_DESCRIPTION = "Role to assign in this workspace."


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_workspace(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    body: WorkspaceCreate,
) -> WorkspacePublic:
    """Create a workspace in the caller's organization. Owners and admins only."""
    return await service.create_workspace(user=current_identity, workspace_create=body)


@router.get("")
async def list_workspaces(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    skip: Annotated[int, Query(ge=0, description="Number of records to skip")] = 0,
    limit: Annotated[int, Query(ge=1, le=1000, description="Maximum number of records to return")] = 100,
) -> WorkspacesPublic:
    """List the workspaces the caller can see in their organization."""
    return await service.list_workspaces(user=current_identity, skip=skip, limit=limit)


@router.get("/{workspace_id}")
async def get_workspace(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
) -> WorkspacePublic:
    """Get one workspace."""
    return await service.get_workspace(user=current_identity, workspace_id=workspace_id)


@router.patch("/{workspace_id}")
async def update_workspace(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
    body: WorkspaceUpdate,
) -> WorkspacePublic:
    """Rename a workspace or change its description."""
    return await service.update_workspace(
        user=current_identity,
        workspace_id=workspace_id,
        workspace_update=body,
    )


@router.delete("/{workspace_id}")
async def delete_workspace(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
) -> Message:
    """Delete a workspace and its memberships. Organization owners and admins only."""
    await service.delete_workspace(user=current_identity, workspace_id=workspace_id)
    return Message(message="Workspace deleted")


@router.get("/{workspace_id}/members")
async def list_workspace_members(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
    skip: Annotated[int, Query(ge=0, description="Number of records to skip")] = 0,
    limit: Annotated[int, Query(ge=1, le=1000, description="Maximum number of records to return")] = 100,
) -> WorkspaceMembersPublic:
    """List a workspace's members."""
    return await service.list_members(
        user=current_identity,
        workspace_id=workspace_id,
        skip=skip,
        limit=limit,
    )


@router.post("/{workspace_id}/members/{user_id}", status_code=status.HTTP_201_CREATED)
async def add_workspace_member(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    role: Annotated[WorkspaceMemberRole, Query(description=WORKSPACE_ROLE_DESCRIPTION)] = "member",
) -> WorkspaceMemberPublic:
    """Add an existing organization member to a workspace."""
    return await service.add_member(
        user=current_identity,
        workspace_id=workspace_id,
        user_id=user_id,
        role=role,
    )


@router.patch("/{workspace_id}/members/{user_id}")
async def update_workspace_member_role(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
    role: Annotated[WorkspaceMemberRole, Query(description=WORKSPACE_ROLE_DESCRIPTION)],
) -> WorkspaceMemberPublic:
    """Change a workspace member's role."""
    return await service.update_member_role(
        user=current_identity,
        workspace_id=workspace_id,
        user_id=user_id,
        role=role,
    )


@router.delete("/{workspace_id}/members/{user_id}")
async def remove_workspace_member(
    service: WorkspaceServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
    user_id: uuid.UUID,
) -> Message:
    """Remove a member from a workspace. Idempotent."""
    await service.remove_member(user=current_identity, workspace_id=workspace_id, user_id=user_id)
    return Message(message="Workspace member removed")


@router.get("/{workspace_id}/visibility")
async def get_workspace_visibility(
    service: WorkspaceVisibilityServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
) -> WorkspaceVisibility:
    """Read what the workspace shows members who do not manage it.

    Any member of the workspace may read it, because the dashboard picks a
    member's layout from it; a workspace the caller cannot see is not found.
    """
    return await service.get_visibility(user=current_identity, workspace_id=workspace_id)


@router.patch("/{workspace_id}/visibility")
async def update_workspace_visibility(
    service: WorkspaceVisibilityServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: uuid.UUID,
    body: WorkspaceVisibilityUpdate,
) -> WorkspaceVisibility:
    """Change what members who do not manage the workspace see; only the fields sent change.

    An organization owner or admin, or an owner or admin of this workspace, may
    change it. With totals shown, a member may read the workspace's aggregate
    usage and its budget in dollars; hidden, only their own usage and the budget
    as a share of its cap. Neither ever shows a member anyone else's requests,
    keys or limits. Answers with every setting after the change.
    """
    return await service.update_visibility(user=current_identity, workspace_id=workspace_id, request=body)
