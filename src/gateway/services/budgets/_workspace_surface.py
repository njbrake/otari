"""What any member of a workspace may read about the workspace's own spend ceiling."""

import uuid
from datetime import datetime

from gateway.core.sql import utc_bound
from gateway.models.budgets import SCOPE_WORKSPACE, Budget, ScopedBudget
from gateway.models.money import as_float
from gateway.models.tenancy import User
from gateway.repositories.budgets import BudgetRepositories
from gateway.schemas.budgets import WorkspaceSpendPublic
from gateway.services.budgets._periods import effective_period
from gateway.services.organizations import WorkspaceVisibilityService
from gateway.services.tenancy.authorization import WorkspaceAccess


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


def _used_fraction(spent: float, cap: float | None) -> float | None:
    """The share of the cap used; None when the budget caps no dollars, and all of it for a zero cap spent against."""
    if cap is None:
        return None
    if cap > 0:
        return spent / cap
    return 1.0 if spent > 0 else 0.0


class _WorkspaceSurface:
    """The workspace ceiling, read by the workspace's own members."""

    def __init__(
        self, repositories: BudgetRepositories, workspaces: WorkspaceAccess, visibility: WorkspaceVisibilityService
    ) -> None:
        self._repositories = repositories
        self._workspaces = workspaces
        self._visibility = visibility

    async def spend(self, *, user: User, workspace_id: uuid.UUID, now: datetime) -> WorkspaceSpendPublic | None:
        # Raises not-found for a workspace the caller cannot see, so this is never
        # an existence oracle.
        workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
        found = await self._repositories.ceilings.for_scope(SCOPE_WORKSPACE, str(workspace.id), None)
        if found is None:
            return None
        ceiling, budget = found
        start, end, settled = _window_and_settled(ceiling, budget, now)
        # Holds survive a roll, so they count in either window.
        spent = settled + float(ceiling.reserved_spend)
        reader = await self._visibility.reader(user=user, workspace=workspace)
        return WorkspaceSpendPublic.from_ceiling(
            workspace.id,
            budget,
            spent=spent if reader.shows_spend else None,
            used_fraction=reader.share(_used_fraction(spent, as_float(budget.max_budget))),
            period_start=utc_bound(start),
            period_end=utc_bound(end),
        )
