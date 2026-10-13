"""What a workspace shows the members who do not manage it, and what that lets one caller read.

A member who does not manage a workspace reads their own usage in it. While the
workspace's managers share its totals (off until they turn it on), a member may also ask for
the workspace's aggregates: totals, the time series, and breakdowns by model,
provider or status code. Nothing that names another person, key or session: no
breakdown by user, key, source or session, no filter on one, and never the rows
themselves. Managers and deployment operators read everything either way.

:class:`WorkspaceReader` is that decision for one caller and one workspace, made
from the workspace row. A setting added to the workspace's visibility widens a
member's reader in :meth:`WorkspaceReader.of` and nowhere else: the usage reads,
the budget surface and the overview only ask the reader.
"""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from typing import Literal

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import (
    WorkspaceTotalsHiddenError,
    WorkspaceTotalsNarrowingError,
)
from gateway.models.tenancy import User, Workspace
from gateway.repositories.tenancy import WorkspaceRepository
from gateway.schemas.organizations import WorkspaceVisibility, WorkspaceVisibilityUpdate
from gateway.schemas.usage import SummaryDimension
from gateway.services.tenancy.authorization import WorkspaceAccess
from gateway.services.tenancy.deployment_user_service import DeploymentUserService

# The breakdowns a member may split shared workspace totals by. A failure's
# status code names no one, so the summary's error breakdown is among them.
MEMBER_TOTALS_DIMENSIONS: tuple[SummaryDimension, ...] = ("model", "provider", "status_code")
# The filters a member may narrow shared workspace totals by: the window, and what
# was asked of which model. An allowlist, so a filter added later that picks out a
# person, a key, a source, a channel or a session is refused until it is judged.
# The endpoint and whether a row counts toward the budget are left off: the
# Playground's endpoint is the Playground channel, and rows that do not count are
# imported ones, which is a source.
MEMBER_TOTALS_FILTERS = frozenset(
    {
        "start_date",
        "end_date",
        "workspace_id",
        "status",
        "exclude_status",
        "status_code",
        "model",
        "exclude_model",
        "requested_model",
        "provider",
        "priced",
    }
)


@dataclass(frozen=True)
class WorkspaceReader:
    """What one caller may read of one workspace's usage and budget.

    ``sees_everyone`` is a deployment operator or a manager of the workspace,
    who read everything. Anyone else is a member, whose reach the workspace's
    visibility settings decide: ``totals_shared``, and the breakdowns and
    filters they may apply to the workspace's totals.
    """

    sees_everyone: bool
    totals_shared: bool
    totals_dimensions: tuple[SummaryDimension, ...]
    totals_filters: frozenset[str]

    @classmethod
    def of(cls, workspace: Workspace, *, sees_everyone: bool) -> "WorkspaceReader":
        """The reader the workspace's settings make of a caller, given whether they see everyone in it."""
        shared = workspace.members_see_workspace_totals
        return cls(
            sees_everyone=sees_everyone,
            totals_shared=shared,
            totals_dimensions=MEMBER_TOTALS_DIMENSIONS if shared else (),
            totals_filters=MEMBER_TOTALS_FILTERS if shared else frozenset(),
        )

    @property
    def reads_workspace_totals(self) -> bool:
        """Whether this caller may read the workspace's aggregate figures."""
        return self.sees_everyone or self.totals_shared

    @property
    def shows_spend(self) -> bool:
        """Whether this caller reads the workspace's spend in dollars: the same setting as its totals."""
        return self.reads_workspace_totals

    def share(self, fraction: float | None) -> float | None:
        """A share of the cap as this caller reads it: exact, or to a whole percent where spend is hidden.

        A whole percent, so the share times the cap gives the spend back only to
        a hundredth of the cap, not to the cent.
        """
        if fraction is None or self.shows_spend:
            return fraction
        return round(fraction, 2)

    def require_totals(self, *, breakdowns: Collection[str], filters: Collection[str]) -> None:
        """Refuse a read of the workspace's totals this caller may not make.

        ``breakdowns`` are the dimensions the read splits by and ``filters`` the
        names of the filters it sets.

        Raises:
            WorkspaceTotalsHiddenError: a member asked while the workspace keeps its totals from members.
            WorkspaceTotalsNarrowingError: a member split or narrowed the totals by something not allowed.
        """
        if self.sees_everyone:
            return
        if not self.totals_shared:
            raise WorkspaceTotalsHiddenError
        for breakdown in breakdowns:
            if breakdown not in self.totals_dimensions:
                raise WorkspaceTotalsNarrowingError(breakdown)
        for name in filters:
            if name not in self.totals_filters:
                raise WorkspaceTotalsNarrowingError(name)


@dataclass(frozen=True)
class UsageReach:
    """How much of a workspace's usage one read covers.

    ``rows`` is everyone's rows, the workspace's aggregates for a member who
    asked for them, or the caller's own rows. ``dimensions`` is what a member's
    totals summary splits by when it names no breakdown; None otherwise.
    """

    rows: Literal["everyone", "workspace_totals", "own"]
    dimensions: tuple[SummaryDimension, ...] | None = None


class WorkspaceVisibilityService:
    """Read and change what a workspace shows its members, and decide what one caller reads of it."""

    def __init__(
        self,
        uow: UnitOfWork,
        settings: WorkspaceRepository,
        workspaces: WorkspaceAccess,
        operators: DeploymentUserService,
    ) -> None:
        self._uow = uow
        self._settings = settings
        self._workspaces = workspaces
        self._operators = operators

    async def get_visibility(self, *, user: User, workspace_id: uuid.UUID) -> WorkspaceVisibility:
        """Return the settings to anyone who may see the workspace; anyone else is told it does not exist."""
        async with self._uow:
            workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
            return WorkspaceVisibility.of(workspace)

    async def update_visibility(
        self, *, user: User, workspace_id: uuid.UUID, request: WorkspaceVisibilityUpdate
    ) -> WorkspaceVisibility:
        """Change the settings sent, as an organization owner or admin or an owner or admin of the workspace."""
        async with self._uow:
            workspace = await self._workspaces.resolve_visible_workspace(user=user, workspace_id=workspace_id)
            await self._workspaces.require_workspace_management_access(user=user, workspace=workspace)
            changes = request.model_dump(exclude_unset=True)
            if changes:
                workspace = await self._settings.update_visibility(workspace, changes)
            return WorkspaceVisibility.of(workspace)

    async def reader(self, *, user: User, workspace: Workspace, is_operator: bool | None = None) -> WorkspaceReader:
        """What this caller may read of ``workspace``, a row the caller already resolved.

        A deployment operator is anyone ``DeploymentUserService.has_administration_access``
        admits, the same line the deployment-wide usage API draws. A caller that
        already asked passes the answer as ``is_operator``.
        """
        if is_operator is None:
            is_operator = await self._operators.has_administration_access(user)
        sees_everyone = is_operator or await self._workspaces.manages(user=user, workspace=workspace)
        return WorkspaceReader.of(workspace, sees_everyone=sees_everyone)

    async def usage_reach(
        self,
        *,
        user: User,
        workspace: Workspace,
        workspace_totals: bool,
        breakdowns: Collection[str],
        filters: Collection[str],
    ) -> UsageReach:
        """How much of ``workspace``'s usage this caller's read covers.

        ``workspace_totals`` is the member's explicit ask; without it a member
        reads their own rows, as before the setting existed. ``breakdowns`` and
        ``filters`` are as :meth:`WorkspaceReader.require_totals` takes them.
        """
        reader = await self.reader(user=user, workspace=workspace)
        if reader.sees_everyone:
            return UsageReach("everyone")
        if not workspace_totals:
            return UsageReach("own")
        reader.require_totals(breakdowns=breakdowns, filters=filters)
        return UsageReach("workspace_totals", dimensions=reader.totals_dimensions)
