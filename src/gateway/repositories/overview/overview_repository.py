"""Counts and allocations for the dashboard overview.

Every query here answers with a number or a handful of rows, never a
collection. That is the point: the overview used to read four whole tables in
the browser to render three integers and one worst-case row (otari#1425).
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, Row, String, Subquery, and_, case, cast, func, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from gateway.core.usage_filters import requests_and_failures, spend_by_key, spend_by_workspace, window_rows
from gateway.models.api_keys import APIKey
from gateway.models.budgets import RESET_ALIGNMENTS, SCOPE_API_TOKEN, SCOPE_WORKSPACE, Budget, ScopedBudget
from gateway.models.tenancy import Workspace, WorkspaceMember
from gateway.models.users import User

_ZERO = Decimal(0)


@dataclass(frozen=True)
class Ceiling:
    """An aggregate dollar ceiling's cap, its counters as stored, and the cadence it rolls on."""

    limit: float
    current_spend: float
    reserved_spend: float
    period_start: datetime | None
    period_end: datetime | None
    duration: int | None
    alignment: str | None


@dataclass(frozen=True)
class Allocation:
    """One row with a finite cap: what it is called, spent, and may spend.

    ``scope_type`` and ``scope_id`` are a ceiling's and are None for a budget
    judged through its users, which caps no scope. A ceiling nobody named is
    named on screen after what it caps ("A workspace"), so the scope has to
    survive the reduction or the row would fall back to an id fingerprint.
    """

    name: str | None
    budget_id: str
    spent: float
    allocated: float
    scope_type: str | None = None
    scope_id: str | None = None


@dataclass(frozen=True)
class KeySpend:
    """A key, who it bills, what it billed in a window, and its ceiling."""

    id: str
    name: str | None
    user_id: str | None
    owner_name: str | None
    last_used_at: datetime | None
    expires_at: datetime | None
    billed: float
    # Rows the key recorded in the window, and how many of them this deployment served.
    rows: int
    served_rows: int
    ceiling: Ceiling | None
    # Among the most billed, so listed; otherwise read only as an attention candidate.
    in_rail: bool


@dataclass(frozen=True)
class WorkspaceSpend:
    """A workspace, what it billed in a window and when it was last used in it, and its ceiling."""

    id: uuid.UUID
    name: str
    billed: float
    last_used_at: datetime | None
    ceiling: Ceiling | None
    in_rail: bool


@dataclass(frozen=True)
class WorkspaceSpends:
    """An organization's workspaces worth reading, and the window's requests and failures across all of them."""

    workspaces: list[WorkspaceSpend]
    requests: int
    failures: int


@dataclass(frozen=True)
class Candidates:
    """How many rows past the rail may be read as attention candidates, and what makes one."""

    limit: int
    # A ceiling at or past this share of its cap, counting holds.
    warn_fraction: float
    # An expiry inside ``(expiring_after, expiring_before]``. Keys only.
    expiring_after: datetime
    expiring_before: datetime


def _in_scope(organization_id: uuid.UUID, workspace_id: uuid.UUID | None) -> Any:
    """One workspace, else every workspace the organization holds, as ``window_rows`` takes them."""

    if workspace_id is not None:
        return workspace_id
    return select(col(Workspace.id)).where(col(Workspace.organization_id) == organization_id)


def _ceilings(organization_id: uuid.UUID, scope_type: str) -> Subquery:
    """The organization's aggregate dollar ceilings of one scope type, one per scope id.

    Aggregate means narrowed to no provider key: one narrowed to a provider caps
    part of the scope's traffic, not the scope. The unique index on the identity
    of aggregate rows is what keeps the outer join from fanning out.
    """

    return (
        select(
            ScopedBudget.scope_id.label("scope_id"),
            Budget.max_budget.label("cap"),
            ScopedBudget.current_spend.label("cap_spent"),
            ScopedBudget.reserved_spend.label("cap_reserved"),
            ScopedBudget.period_start.label("period_start"),
            ScopedBudget.period_end.label("period_end"),
            Budget.budget_duration_sec.label("duration"),
            Budget.reset_alignment.label("alignment"),
        )
        .join(Budget, Budget.budget_id == ScopedBudget.budget_id)
        .where(
            Budget.organization_id == organization_id,
            ScopedBudget.scope_type == scope_type,
            ScopedBudget.provider_key_id.is_(None),
            Budget.max_budget.is_not(None),
        )
        .subquery()
    )


def _near_cap(ranked: Subquery, warn_fraction: float) -> ColumnElement[bool]:
    """A wide filter for a ceiling worth judging: the service decides exactly, against the rolled period."""

    used = ranked.c.cap_spent + ranked.c.cap_reserved
    # A zero cap with nothing against it passes the fraction test and yields no item.
    return and_(
        ranked.c.cap.is_not(None),
        used >= ranked.c.cap * Decimal(str(warn_fraction)),
        or_(ranked.c.cap > 0, used > 0),
    )


def _ceiling(row: Row[Any]) -> Ceiling | None:
    if row.cap is None:
        return None
    return Ceiling(
        limit=float(row.cap),
        current_spend=float(row.cap_spent),
        reserved_spend=float(row.cap_reserved),
        period_start=row.period_start,
        period_end=row.period_end,
        duration=row.duration,
        alignment=row.alignment,
    )


@dataclass(frozen=True)
class CeilingRollup:
    """Capped spend ceilings reduced to what a strip renders: counts and the worst row."""

    capped_count: int
    over_count: int
    near_count: int
    worst: Allocation | None


def _owned_by(organization_id: uuid.UUID | None) -> ColumnElement[bool]:
    """The budgets an organization owns, or the deployment's own when ``organization_id`` is ``None``."""
    if organization_id is None:
        return Budget.organization_id.is_(None)
    return Budget.organization_id == organization_id


def _settled_at(now: datetime) -> ColumnElement[Any]:
    """A ceiling's settled spend as the gate's roll will leave it at ``now``.

    The roll runs only when a request next reaches the ceiling, so until then a
    ceiling whose period ran out still holds the last period's spend. The roll
    zeroes it (holds survive) unless the alignment is one it cannot read, which
    keeps the stored window, as ``services.budgets.effective_period`` does.
    """
    rolls = and_(
        ScopedBudget.period_end.is_not(None),
        ScopedBudget.period_end <= now,
        or_(Budget.reset_alignment.is_(None), Budget.reset_alignment.in_(RESET_ALIGNMENTS)),
    )
    return case((rolls, literal(_ZERO)), else_=ScopedBudget.current_spend)


class OverviewRepository:
    """Aggregate reads behind the overview's counts and health strips."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def count_active_keys(self, *, workspace_id: uuid.UUID | None, organization_id: uuid.UUID | None) -> int:
        """Active keys, narrowed the way the keys page narrows its own list.

        A workspace is the tighter scope and wins when both are given, which is
        what keeps this equal to the count the API keys page would show: the
        rail it feeds links there, so the two cannot disagree. With neither, the
        count is deployment-wide, which only an operator is allowed to ask for.

        There is no organization column on a key, so the organization scope is
        the workspaces that belong to it. That is the same route the key list
        takes to answer the question.
        """

        stmt = select(func.count()).select_from(APIKey).where(APIKey.is_active.is_(True))
        if workspace_id is not None:
            return int(await self.db.scalar(stmt.where(APIKey.workspace_id == workspace_id)) or 0)
        if organization_id is not None:
            stmt = stmt.join(Workspace, APIKey.workspace_id == col(Workspace.id)).where(
                col(Workspace.organization_id) == organization_id
            )
        return int(await self.db.scalar(stmt) or 0)

    async def count_active_workspace_members(self, workspace_id: uuid.UUID) -> int:
        """Active members of one workspace.

        One workspace, never the organization: the rail this feeds is headed
        "This workspace", and an organization member need not be a member of
        every workspace, so an organization-wide count would overcount it and
        stay put when the switcher moves.
        """

        stmt = (
            select(func.count())
            .select_from(WorkspaceMember)
            .where(col(WorkspaceMember.workspace_id) == workspace_id, col(WorkspaceMember.status) == "active")
        )
        return int(await self.db.scalar(stmt) or 0)

    async def budget_allocations(self, *, owner_organization_id: uuid.UUID | None) -> list[Allocation]:
        """Capped budgets held by users, with the spend against each.

        ``max_budget`` is a per-user cap that a budget's users share, so the
        honest allocation is the cap times the number of active users holding
        it, which is what the budgets page shows. A budget with no cap or no
        users has no utilization to judge and is left out. Read for the budgets
        ``owner_organization_id`` owns, or the deployment's own when it is ``None``.

        One grouped pass rather than a count per budget: this runs on every
        overview load, and a query per row is what makes a summary cost more
        than the collection it replaced.
        """

        rollup = (
            select(
                User.budget_id.label("budget_id"),
                func.count().label("user_count"),
                # ``Decimal`` defaults rather than 0.0, for the reason
                # ``routes/budgets.py`` gives: in PostgreSQL
                # ``coalesce(numeric, double precision)`` resolves the sum as
                # double precision and rolls exact counters up through a float.
                func.coalesce(func.sum(User.spend), _ZERO).label("spend"),
                func.coalesce(func.sum(User.reserved), _ZERO).label("reserved"),
            )
            .where(User.budget_id.is_not(None), User.deleted_at.is_(None))
            .group_by(User.budget_id)
            .subquery()
        )
        stmt = (
            select(Budget, rollup.c.user_count, rollup.c.spend, rollup.c.reserved)
            .join(rollup, Budget.budget_id == rollup.c.budget_id)
            .where(_owned_by(owner_organization_id), Budget.max_budget.is_not(None))
        )
        rows = (await self.db.execute(stmt)).all()
        return [
            Allocation(
                name=budget.name,
                budget_id=budget.budget_id,
                spent=float(spend) + float(reserved),
                allocated=float(budget.max_budget) * user_count,
            )
            for budget, user_count, spend, reserved in rows
            if user_count > 0
        ]

    async def ceiling_rollup(
        self, *, owner_organization_id: uuid.UUID | None, warn_at: float, now: datetime
    ) -> CeilingRollup:
        """Capped spend ceilings on the budgets ``owner_organization_id`` owns, reduced in SQL.

        The deployment's own budgets when it is ``None``. A ceiling carries its
        own counters, so its allocation is the budget's ``max_budget`` itself.
        Counted and ranked in the database, so an overview load costs two rows
        however many scopes carry a ceiling. Read as the gate's roll will leave
        each one at ``now`` (see :func:`_settled_at`).
        """
        spent = _settled_at(now) + ScopedBudget.reserved_spend
        # The ratio the overview judges by: a zero cap admits nothing, so any
        # spend against it reads as fully used.
        utilization = case(
            (Budget.max_budget > 0, spent / Budget.max_budget),
            (spent > 0, literal(1.0)),
            else_=literal(0.0),
        )
        capped = (
            select(ScopedBudget.id, utilization.label("utilization"))
            .join(Budget, ScopedBudget.budget_id == Budget.budget_id)
            .where(_owned_by(owner_organization_id), Budget.max_budget.is_not(None))
        ).subquery()
        counts = (
            await self.db.execute(
                select(
                    func.count(),
                    func.count().filter(capped.c.utilization >= 1),
                    func.count().filter(capped.c.utilization >= warn_at, capped.c.utilization < 1),
                ).select_from(capped)
            )
        ).one()
        worst_row = (
            await self.db.execute(
                select(ScopedBudget, Budget.max_budget, spent)
                .join(Budget, ScopedBudget.budget_id == Budget.budget_id)
                .where(_owned_by(owner_organization_id), Budget.max_budget.is_not(None))
                .order_by(utilization.desc(), ScopedBudget.id)
                .limit(1)
            )
        ).first()
        worst = None
        if worst_row is not None:
            ceiling, max_budget, worst_spent = worst_row
            worst = Allocation(
                name=ceiling.name,
                budget_id=ceiling.budget_id,
                spent=float(worst_spent),
                allocated=float(max_budget),
                scope_type=ceiling.scope_type,
                scope_id=ceiling.scope_id,
            )
        return CeilingRollup(capped_count=counts[0], over_count=counts[1], near_count=counts[2], worst=worst)

    async def count_ceilings(self, organization_id: uuid.UUID) -> int:
        """Every ceiling the organization has, capped or not.

        Separate from :meth:`ceiling_rollup` because the page tells the two
        apart: no ceilings at all reads differently from ceilings that cap
        tokens or requests rather than dollars.
        """

        stmt = (
            select(func.count())
            .select_from(ScopedBudget)
            .join(Budget, ScopedBudget.budget_id == Budget.budget_id)
            .where(Budget.organization_id == organization_id)
        )
        return int(await self.db.scalar(stmt) or 0)

    async def count_budgets(self, *, owner_organization_id: uuid.UUID | None) -> int:
        """Every budget ``owner_organization_id`` owns (the deployment's when ``None``), capped or not."""
        stmt = select(func.count()).select_from(Budget).where(_owned_by(owner_organization_id))
        return int(await self.db.scalar(stmt) or 0)

    async def keys_with_spend(
        self,
        *,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None,
        owner_user_id: str | None,
        start: datetime,
        end: datetime,
        rail_rows: int,
        candidates: Candidates,
    ) -> list[KeySpend]:
        """Active keys in the organization (one workspace, one owner) with their window's spend and ceiling.

        The ``rail_rows`` most billed, then up to ``candidates.limit`` more that
        might need attention: a ceiling near its cap, or an expiry close. Never
        every key, so the read stays bounded however many keys a workspace has.
        Internal keys are left out, as the key lists leave them out. One
        statement: the spend is a grouped pass over the window, and the ceiling
        an outer join.
        """

        # Narrow the grouped pass to the rows the outer query can keep, so it
        # does not sum the whole organization's month to answer for one owner.
        owned = select(APIKey.id).where(APIKey.user_id == owner_user_id) if owner_user_id is not None else None
        spend = spend_by_key(window_rows(start, end, _in_scope(organization_id, workspace_id), api_key_ids=owned))
        ceilings = _ceilings(organization_id, SCOPE_API_TOKEN)
        billed = func.coalesce(spend.c.billed, 0.0)
        keys = (
            select(
                APIKey.id.label("id"),
                APIKey.key_name.label("name"),
                APIKey.user_id.label("user_id"),
                User.alias.label("owner_name"),
                APIKey.last_used_at.label("last_used_at"),
                APIKey.expires_at.label("expires_at"),
                billed.label("billed"),
                func.coalesce(spend.c.rows, 0).label("rows"),
                func.coalesce(spend.c.served, 0).label("served"),
                *(column for column in ceilings.c if column.key != "scope_id"),
                func.row_number().over(order_by=(billed.desc(), APIKey.key_name, APIKey.id)).label("rank"),
            )
            .join(Workspace, col(Workspace.id) == APIKey.workspace_id)
            .outerjoin(spend, spend.c.key_id == APIKey.id)
            .outerjoin(User, User.user_id == APIKey.user_id)
            .outerjoin(ceilings, ceilings.c.scope_id == APIKey.id)
            .where(
                col(Workspace.organization_id) == organization_id,
                APIKey.is_active.is_(True),
                APIKey.internal_secret.is_(None),
            )
        )
        if workspace_id is not None:
            keys = keys.where(APIKey.workspace_id == workspace_id)
        if owner_user_id is not None:
            keys = keys.where(APIKey.user_id == owner_user_id)
        ranked = keys.subquery()
        expiring = and_(
            ranked.c.expires_at > candidates.expiring_after, ranked.c.expires_at <= candidates.expiring_before
        )
        stmt = (
            select(ranked)
            .where(or_(ranked.c.rank <= rail_rows, _near_cap(ranked, candidates.warn_fraction), expiring))
            .order_by(ranked.c.rank)
            .limit(rail_rows + candidates.limit)
        )
        return [
            KeySpend(
                id=row.id,
                name=row.name,
                user_id=row.user_id,
                owner_name=row.owner_name,
                last_used_at=row.last_used_at,
                expires_at=row.expires_at,
                billed=float(row.billed),
                rows=int(row.rows),
                served_rows=int(row.served),
                ceiling=_ceiling(row),
                in_rail=row.rank <= rail_rows,
            )
            for row in (await self.db.execute(stmt)).all()
        ]

    async def workspaces_with_spend(
        self,
        *,
        organization_id: uuid.UUID,
        start: datetime,
        end: datetime,
        rail_rows: int,
        candidates: Candidates,
    ) -> WorkspaceSpends:
        """The organization's most billed workspaces, those whose ceiling is near its cap, and the window's totals.

        One statement. The grouped pass that sums each workspace's spend also
        counts its requests and failures, and a window over every workspace adds
        those up before the rail is cut, so the organization's error rate needs
        no second read of its month. Imported rows count toward both, as the
        usage reads count them.
        """

        spend = spend_by_workspace(window_rows(start, end, _in_scope(organization_id, None)))
        ceilings = _ceilings(organization_id, SCOPE_WORKSPACE)
        billed = func.coalesce(spend.c.billed, 0.0)
        ranked = (
            select(
                col(Workspace.id).label("id"),
                col(Workspace.name).label("name"),
                billed.label("billed"),
                spend.c.last_used_at,
                *(column for column in ceilings.c if column.key != "scope_id"),
                func.row_number().over(order_by=(billed.desc(), col(Workspace.name), col(Workspace.id))).label("rank"),
                func.sum(func.coalesce(spend.c.requests, 0)).over().label("all_requests"),
                func.sum(func.coalesce(spend.c.failures, 0)).over().label("all_failures"),
            )
            .outerjoin(spend, spend.c.workspace_id == col(Workspace.id))
            .outerjoin(ceilings, ceilings.c.scope_id == cast(col(Workspace.id), String))
            .where(col(Workspace.organization_id) == organization_id)
            .subquery()
        )
        stmt = (
            select(ranked)
            .where(or_(ranked.c.rank <= rail_rows, _near_cap(ranked, candidates.warn_fraction)))
            .order_by(ranked.c.rank)
            .limit(rail_rows + candidates.limit)
        )
        rows = (await self.db.execute(stmt)).all()
        return WorkspaceSpends(
            workspaces=[
                WorkspaceSpend(
                    id=row.id,
                    name=row.name,
                    billed=float(row.billed),
                    last_used_at=row.last_used_at,
                    ceiling=_ceiling(row),
                    in_rail=row.rank <= rail_rows,
                )
                for row in rows
            ],
            requests=int(rows[0].all_requests) if rows else 0,
            failures=int(rows[0].all_failures) if rows else 0,
        )

    async def workspace_ceiling(self, organization_id: uuid.UUID, workspace_id: uuid.UUID) -> Ceiling | None:
        """The organization's aggregate dollar ceiling on one workspace, if it has one."""

        ceilings = _ceilings(organization_id, SCOPE_WORKSPACE)
        row = (await self.db.execute(select(ceilings).where(ceilings.c.scope_id == str(workspace_id)))).first()
        return _ceiling(row) if row is not None else None

    async def requests_and_failures(
        self,
        *,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None,
        user_id: str | None,
        start: datetime,
        end: datetime,
    ) -> tuple[int, int]:
        """Requests in the window (one workspace, else the organization; one user, else everyone) and failures.

        Requests are counted the way every usage read counts them: an attempt a
        routing policy recovered from is part of the request it served. Imported
        rows count too, as they do on the Usage page.
        """

        where = window_rows(start, end, _in_scope(organization_id, workspace_id), user_id=user_id)
        row = (await self.db.execute(requests_and_failures(where))).one()
        return int(row[0] or 0), int(row[1] or 0)
