"""A workspace's own spend ceiling, readable by every member of the workspace.

The ceilings route (``/organizations/me/spend-ceilings``) is an owner's or
admin's, because it lists every cap in the organization. This is the one figure a
member may see: the workspace-wide ceiling of a workspace they belong to, so the
Activity page can show how much of it their team has used.
"""

import uuid

from fastapi import APIRouter, Depends

from gateway.api.deps import BudgetServiceDep, CurrentIdentity, verify_master_key
from gateway.schemas.budgets import WorkspaceSpendPublic

router = APIRouter(
    prefix="/workspaces/{workspace_id}/budget",
    tags=["workspace-budget"],
    dependencies=[Depends(verify_master_key)],
)


@router.get("")
async def get_workspace_budget(
    workspace_id: uuid.UUID,
    service: BudgetServiceDep,
    current_identity: CurrentIdentity,
) -> WorkspaceSpendPublic | None:
    """Return the workspace's own spend ceiling for the current period, or null when it has none.

    Any member of the workspace may read it, as may an organization owner or
    admin; a workspace the caller cannot see is not found. ``spent`` is settled
    spend plus holds in flight, what the gate enforces against.
    """
    return await service.workspace_spend(user=current_identity, workspace_id=workspace_id)
