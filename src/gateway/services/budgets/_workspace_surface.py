"""What any member of a workspace may read about the workspace's own spend ceiling."""

import uuid
from datetime import datetime

from gateway.core.sql import utc_bound
from gateway.models.budgets import SCOPE_WORKSPACE, Budget, ScopedBudget
from gateway.models.tenancy import User
from gateway.repositories.budgets import BudgetRepositories
from gateway.schemas.budgets import WorkspaceSpendPublic
from gateway.services.budgets._periods import effective_period
from gateway.services.tenancy import WorkspaceService


def _window_and_settled(
    ceiling: ScopedBudget, budget: Budget, now: datetime
) -> tuple[datetime | None, datetime | None, float]:
    """The ceiling's window and settled spend as the request gate would read them at ``now``.

    A period rolls only when a request next reaches the gate, so a ceiling nobody
    has spent against since its window closed still holds the last window's
    counters. Read it the way that roll would leave it, through the same
    :func:`effective_period`: nothing settled yet. An alignment the roll cannot read
    keeps the stored window, as the roll does.
    """
    try:
        rolled = effective_period(
            ceiling.period_end, now, duration=budget.budget_duration_sec, alignment=budget.reset_alignment
        )
    except ValueError:
        rolled = None
    if rolled is None:
        return ceiling.period_start, ceiling.period_end, float(ceiling.current_spend)
    return rolled[0], rolled[1], 0.0


class _WorkspaceSurface:
    """The workspace ceiling, read by the workspace's own members."""

    def __init__(self, repositories: BudgetRepositories, workspaces: WorkspaceService) -> None:
        self._repositories = repositories
        self._workspaces = workspaces

    async def spend(self, *, user: User, workspace_id: uuid.UUID, now: datetime) -> WorkspaceSpendPublic | None:
        # Raises not-found for a workspace the caller cannot see, so this is never
        # an existence oracle.
        workspace = await self._workspaces.workspace_in_active_organization(user=user, workspace_id=workspace_id)
        found = await self._repositories.ceilings.for_scope(SCOPE_WORKSPACE, str(workspace.id), None)
        if found is None:
            return None
        ceiling, budget = found
        start, end, settled = _window_and_settled(ceiling, budget, now)
        return WorkspaceSpendPublic.from_ceiling(
            workspace.id,
            budget,
            # Holds survive a roll, so they count in either window.
            spent=settled + float(ceiling.reserved_spend),
            period_start=utc_bound(start),
            period_end=utc_bound(end),
        )
