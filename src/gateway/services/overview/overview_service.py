"""The overview's counts and budget health, judged server-side.

The dashboard used to answer these by downloading four collections and
reducing them in the browser (otari#1425). What it renders is three integers
and one worst-case row, so that is what this returns.

The split with the dashboard is deliberate: **this scans, the dashboard
writes the copy.** Deciding which row is worst means reading every row, which
is the expensive half and belongs here. Turning "two rows over their limit"
into the words on the strip is presentation, and putting it on the wire would
make the API own UI copy and freeze the page's wording into four SDKs.
"""

import asyncio
import calendar
import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Literal

from gateway.core.config import GatewayConfig
from gateway.core.sql import utc_bound
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import NotAuthorizedError, WorkspaceNotFoundError
from gateway.models.tenancy import Organization, Workspace
from gateway.models.tenancy import User as TenancyUser
from gateway.repositories.overview.overview_repository import (
    Allocation,
    Candidates,
    Ceiling,
    CeilingRollup,
    KeySpend,
    OverviewRepository,
    WorkspaceSpend,
)
from gateway.schemas.organizations import WorkspaceVisibility
from gateway.schemas.overview import AttentionKind, OverviewScope
from gateway.services.budgets import effective_period
from gateway.services.model_discovery_service import get_model_cache
from gateway.services.organizations import WorkspaceReader, WorkspaceVisibilityService
from gateway.services.tenancy.deployment_user_service import DeploymentUserService
from gateway.services.tenancy.organization_service import OrganizationService
from gateway.services.tenancy.workspace_service import WorkspaceService
from gateway.services.usage import UsageReadService, UsageRows, heavy_usage_read

# The thresholds every needs-attention item is judged by, in one place so the page
# never judges one itself.
#
# Where a row stops being comfortable. The dashboard used the same fraction when
# it did this scan itself; it is here now because the counts below are what it
# is for, and a second definition is how the two would drift apart.
BUDGET_WARN = 0.8
# How soon an expiry is worth saying.
KEY_EXPIRY_NOTICE = timedelta(days=7)
# A month's failure rate worth saying, and the fewest requests a rate means anything over.
ERROR_RATE_ALERT = 0.10
ERROR_RATE_MIN_REQUESTS = 20
# How many keys or workspaces the rail lists, most billed first.
LIMIT_ROWS = 8
# How many more past the rail may be read as attention candidates: enough for any
# page worth reading, and a bound on the read however many keys a workspace has.
ATTENTION_CANDIDATES = 50
# The least run a pace is projected from: a day, or a tenth of the period if longer.
PACE_MIN_ELAPSED = timedelta(days=1)
PACE_MIN_SHARE = 0.1

# Most severe first, and within a severity, the order a reader would act on them.
_ATTENTION_ORDER: tuple[AttentionKind, ...] = (
    "provider_unreachable",
    "budget_over",
    "key_over_limit",
    "error_rate",
    "budget_near",
    "budget_pace",
    "key_near_limit",
    "key_expiring",
)


@dataclass(frozen=True)
class Month:
    """One UTC calendar month, and how far into it ``now`` is."""

    start: datetime
    end: datetime
    elapsed_days: int
    days: int

    @classmethod
    def of(cls, year: int, month: int, now: datetime) -> "Month":
        """The month ``year-month`` as seen at ``now``; raises ``ValueError`` for a date that does not exist."""

        start = datetime(year, month, 1, tzinfo=UTC)
        days = calendar.monthrange(year, month)[1]
        end = start + timedelta(days=days)
        elapsed = days if now >= end else now.day
        return cls(start=start, end=end, elapsed_days=elapsed, days=days)

    @classmethod
    def current(cls, now: datetime) -> "Month":
        return cls.of(now.year, now.month, now)


@dataclass(frozen=True)
class AttentionItem:
    """One thing worth acting on now, with the figures that make it so."""

    kind: AttentionKind
    severity: Literal["alert", "warn"]
    subject_id: str | None
    subject_name: str | None
    used: float | None = None
    limit: float | None = None
    fraction: float | None = None
    at: datetime | None = None
    count: int | None = None


@dataclass(frozen=True)
class LimitRow:
    """One key or workspace in the rail."""

    id: str
    name: str | None
    owner_name: str | None
    is_mine: bool
    spent: float
    limit: float | None
    limit_spent: float | None
    period_end: datetime | None
    last_used_at: datetime | None
    expires_at: datetime | None
    is_subscription: bool


@dataclass(frozen=True)
class Limits:
    """The rail: keys or workspaces."""

    kind: Literal["keys", "workspaces"]
    rows: list[LimitRow]


@dataclass(frozen=True)
class WorstAllocation:
    """The single row furthest through its allowance."""

    budget_id: str
    name: str | None
    spent: float
    allocated: float
    scope_type: str | None
    scope_id: str | None


@dataclass(frozen=True)
class AllocationHealth:
    """The scan of one set of capped rows."""

    over_count: int
    near_count: int
    capped_count: int
    total_count: int
    worst: WorstAllocation | None


@dataclass(frozen=True)
class OverviewSummary:
    """Everything the overview renders that is not a usage series."""

    active_keys: int
    active_members: int
    budgets: AllocationHealth | None
    ceilings: AllocationHealth | None
    month: Month
    scope: OverviewScope
    attention: list[AttentionItem]
    limits: Limits
    visibility: WorkspaceVisibility | None


def _utilization(row: Allocation) -> float:
    """How far through its allowance a row is.

    A zero allocation admits nothing, so anything spent against one is over it.
    Reported as a full 1.0 rather than the infinite ratio it really is: the share
    has no finite value, and "over budget" tells a reader more than "Infinity%".
    It is a floor, so a row measurably further past its limit still wins ``worst``.
    """

    if row.allocated > 0:
        return row.spent / row.allocated
    return 1.0 if row.spent > 0 else 0.0


def judge(rows: list[Allocation], *, total_count: int, ceilings: CeilingRollup | None = None) -> AllocationHealth:
    """Reduce capped rows, and any ceilings the database already reduced, to counts and the worst of them."""

    scored = [(row, _utilization(row)) for row in rows]
    if ceilings is not None and ceilings.worst is not None:
        scored_worst = [*scored, (ceilings.worst, _utilization(ceilings.worst))]
    else:
        scored_worst = scored
    worst_row = max(scored_worst, key=lambda pair: pair[1], default=None)
    return AllocationHealth(
        over_count=sum(1 for _, pct in scored if pct >= 1) + (ceilings.over_count if ceilings else 0),
        near_count=sum(1 for _, pct in scored if BUDGET_WARN <= pct < 1) + (ceilings.near_count if ceilings else 0),
        capped_count=len(rows) + (ceilings.capped_count if ceilings else 0),
        total_count=total_count,
        worst=(
            WorstAllocation(
                budget_id=worst_row[0].budget_id,
                name=worst_row[0].name,
                spent=worst_row[0].spent,
                allocated=worst_row[0].allocated,
                scope_type=worst_row[0].scope_type,
                scope_id=worst_row[0].scope_id,
            )
            if worst_row is not None
            else None
        ),
    )


class OverviewService:
    """Assembles the dashboard overview's summary for one caller."""

    def __init__(
        self,
        repository: OverviewRepository,
        organizations: OrganizationService,
        operators: DeploymentUserService,
        workspaces: WorkspaceService,
        visibility: WorkspaceVisibilityService,
        config: GatewayConfig,
        uow: UnitOfWork,
        heavy_reads: asyncio.Semaphore,
        usage: UsageReadService,
    ):
        self._repository = repository
        self._organizations = organizations
        self._operators = operators
        self._workspaces = workspaces
        self._visibility = visibility
        # The month's spend and failures are grouped passes over its usage rows,
        # so they take a turn among the worker's heavy usage reads.
        self._uow = uow
        self._heavy_reads = heavy_reads
        # Builds the month's usage relation, from hourly rollups where they are current.
        self._usage = usage
        self._month_relations: dict[
            tuple[uuid.UUID, uuid.UUID | None, datetime, str | None, str | None], UsageRows
        ] = {}
        # Read only for the providers an operator's reachability covers.
        self._config = config

    async def summary(
        self,
        *,
        identity: TenancyUser,
        workspace_id: uuid.UUID | None,
        month: Month,
        scope: OverviewScope,
        now: datetime,
    ) -> OverviewSummary:
        """The counts, health strips, needs-attention list and rail this caller may see.

        Both health fields are optional and both are withheld rather than
        emptied, because the page draws a different strip for "nothing to judge"
        than for "not yours to see". Deployment budgets are the operator's;
        spend ceilings are an organization owner's or admin's, which is the line
        the ceilings route already draws.

        ``scope`` is what the caller asked to read. A scope they may not read
        falls back to ``you`` rather than refusing, and the summary says which
        one it used: a member's overview is a valid page, just a narrower one.

        Ceiling items, ``limit_spent`` and ``key_expiring`` describe ``now``
        whatever the month: a ceiling has one set of counters, and an expiry is
        only worth saying before it happens. Spend and the error rate are the
        month's.
        """

        organization = await self._organizations.get_active_organization_for_user(identity)
        is_deployment_operator = await self._operators.has_administration_access(identity)
        manages_spend = await self._manages_spend(identity, organization)
        # A workspace the caller named has to be one they may see, which is the
        # rule `services.tenancy.authorization` already states: an owner or admin
        # sees every workspace in their organization, anyone else only the ones
        # they are an active member of. Reusing it is what keeps these counts
        # equal to the pages they link to, which resolve the same way.
        #
        # A workspace they may not see is treated as none given rather than
        # refused, because the id comes from a switcher whose contents can go
        # stale and a stale one should not fail the whole page.
        workspace: Workspace | None = None
        if workspace_id is not None:
            try:
                workspace = await self._workspaces.workspace_in_active_organization(
                    user=identity, workspace_id=workspace_id
                )
            except WorkspaceNotFoundError:
                workspace = None
        reader = (
            await self._visibility.reader(user=identity, workspace=workspace, is_operator=is_deployment_operator)
            if workspace
            else None
        )
        used_scope = _allowed_scope(scope, reader=reader, manages_spend=manages_spend)
        # A member reading a workspace's totals: the workspace's figures, and
        # nobody else's keys.
        member_totals = used_scope == "workspace" and reader is not None and not reader.sees_everyone

        budgets = None
        if is_deployment_operator:
            # The deployment strip judges the deployment's own budgets only. A
            # budget an organization owns is one of its spend ceilings, judged on
            # that strip, so no row is counted twice.
            budgets = judge(
                await self._repository.budget_allocations(owner_organization_id=None),
                total_count=await self._repository.count_budgets(owner_organization_id=None),
                ceilings=await self._repository.ceiling_rollup(
                    owner_organization_id=None, warn_at=BUDGET_WARN, now=now
                ),
            )

        ceilings = None
        if manages_spend:
            ceilings = judge(
                [],
                total_count=await self._repository.count_ceilings(organization.id),
                ceilings=await self._repository.ceiling_rollup(
                    owner_organization_id=organization.id, warn_at=BUDGET_WARN, now=now
                ),
            )

        attention: list[AttentionItem] = []
        if is_deployment_operator:
            attention += self._unreachable_providers()
        async with heavy_usage_read(self._uow, self._heavy_reads):
            if used_scope == "organization":
                limits, found, (requests, failures) = await self._workspace_rail(organization, month, now)
            else:
                limits, found = await self._key_rail(
                    identity, organization, workspace, used_scope, month, now, own_keys_only=member_totals
                )
                if workspace is not None and reader is not None:
                    attention += await self._workspace_budget(workspace, month, now, reader=reader)
                requests, failures = await self._repository.requests_and_failures(
                    await self._month_rows(
                        organization.id,
                        workspace.id if workspace else None,
                        month,
                        user_id=str(identity.id) if used_scope == "you" else None,
                    )
                )
        attention += found
        attention += _error_rate(requests, failures)
        attention.sort(key=lambda item: _ATTENTION_ORDER.index(item.kind))

        return OverviewSummary(
            active_keys=await self._repository.count_active_keys(
                workspace_id=workspace.id if workspace else None,
                organization_id=None if is_deployment_operator else organization.id,
            ),
            active_members=((await self._repository.count_active_workspace_members(workspace.id)) if workspace else 0),
            budgets=budgets,
            ceilings=ceilings,
            month=month,
            scope=used_scope,
            attention=attention,
            limits=limits,
            visibility=WorkspaceVisibility.of(workspace) if workspace else None,
        )

    def _unreachable_providers(self) -> list[AttentionItem]:
        """One item per provider whose last reachability check failed, read from the discovery cache.

        Never dials: a provider nobody has checked on this worker yet is not
        reported, rather than this page paying for the check. A provider whose
        backend lists no models is not unreachable, only unverifiable, so it is
        left out, as the providers page leaves it amber rather than red.
        """

        cache = get_model_cache()
        items = []
        for instance in sorted(self._config.providers):
            cached = cache.stale(instance)
            if cached is not None and cached.error is not None and not cached.discovery_unsupported:
                items.append(
                    AttentionItem(
                        kind="provider_unreachable",
                        severity="alert",
                        subject_id=instance,
                        subject_name=instance,
                        used=None,
                        limit=None,
                        fraction=None,
                        at=cache.checked_at(instance),
                        count=None,
                    )
                )
        return items

    async def _key_rail(
        self,
        identity: TenancyUser,
        organization: Organization,
        workspace: Workspace | None,
        scope: OverviewScope,
        month: Month,
        now: datetime,
        *,
        own_keys_only: bool,
    ) -> tuple[Limits, list[AttentionItem]]:
        """The most billed of the caller's keys, or of a managed workspace's; and the keys worth a word.

        Keys past the rail are read only when they may need attention, so a
        small key about to expire is still said without reading every key.
        ``own_keys_only`` is a member reading a workspace's totals: their own
        keys are judged for attention, and the rail lists no key at all, since
        the workspace's keys are other people's.
        """

        mine = str(identity.id)
        workspace_id = workspace.id if workspace else None
        owner = mine if scope == "you" or own_keys_only else None
        keys = await self._repository.keys_with_spend(
            await self._month_rows(organization.id, workspace_id, month, owner_user_id=owner),
            organization_id=organization.id,
            workspace_id=workspace_id,
            owner_user_id=owner,
            rail_rows=LIMIT_ROWS,
            candidates=_candidates(now),
        )
        attention: list[AttentionItem] = []
        for key in keys:
            if key.ceiling is not None:
                attention += _limit_items(
                    _standing(key.ceiling, now),
                    over="key_over_limit",
                    near="key_near_limit",
                    subject_id=key.id,
                    subject_name=key.name,
                )
            expires_at = utc_bound(key.expires_at)
            if expires_at is not None and now < expires_at <= now + KEY_EXPIRY_NOTICE:
                attention.append(_item("key_expiring", "warn", key.id, key.name, at=expires_at))
        rows = [] if own_keys_only else [_key_row(key, mine=mine, now=now) for key in keys if key.in_rail]
        return Limits(kind="keys", rows=rows), attention

    async def _workspace_rail(
        self, organization: Organization, month: Month, now: datetime
    ) -> tuple[Limits, list[AttentionItem], tuple[int, int]]:
        """The organization's most billed workspaces, the ceilings worth a word, and its requests and failures."""

        found = await self._repository.workspaces_with_spend(
            await self._month_rows(organization.id, None, month),
            organization_id=organization.id,
            rail_rows=LIMIT_ROWS,
            candidates=_candidates(now),
        )
        attention: list[AttentionItem] = []
        for ws in found.workspaces:
            if ws.ceiling is not None:
                attention += _limit_items(
                    _standing(ws.ceiling, now),
                    over="budget_over",
                    near="budget_near",
                    subject_id=str(ws.id),
                    subject_name=ws.name,
                )
        rows = [_workspace_row(ws, now) for ws in found.workspaces if ws.in_rail]
        return Limits(kind="workspaces", rows=rows), attention, (found.requests, found.failures)

    async def _month_rows(
        self,
        organization_id: uuid.UUID,
        workspace_id: uuid.UUID | None,
        month: Month,
        *,
        user_id: str | None = None,
        owner_user_id: str | None = None,
    ) -> UsageRows:
        """The month's usage rows in one workspace or the organization, for one user or one owner's keys.

        Built once per set of arguments: a workspace's key rail and its error rate
        read the same rows.
        """

        conditions = self._repository.month_rows(
            organization_id=organization_id,
            workspace_id=workspace_id,
            start=month.start,
            end=month.end,
            user_id=user_id,
            owner_user_id=owner_user_id,
        )
        key = (organization_id, workspace_id, month.start, user_id, owner_user_id)
        if key not in self._month_relations:
            self._month_relations[key] = await self._usage.rows(conditions, month.start, month.end)
        return self._month_relations[key]

    async def _workspace_budget(
        self, workspace: Workspace, month: Month, now: datetime, *, reader: WorkspaceReader
    ) -> list[AttentionItem]:
        """The workspace ceiling the caller spends against: over, near, or on pace to pass it.

        Any member may read it (the workspace budget surface), so it is judged in
        every scope that names the workspace. Pace only for the current month,
        since a month that has ended has no run left to project. A ``reader`` the
        dollars are kept from gets what the budget surface gives them: the cap and
        the share to a whole percent, and a pace projected from that share alone.
        """

        ceiling = await self._repository.workspace_ceiling(workspace.organization_id, workspace.id)
        if ceiling is None:
            return []
        standing = _standing(ceiling, now)
        # Judged from the share the reader sees, so near and over agree with the
        # percent on the item and say nothing finer about the spend.
        judged = standing if reader.shows_spend else _as_shared(standing, reader)
        subject = (str(workspace.id), workspace.name)
        items = _limit_items(
            judged, over="budget_over", near="budget_near", subject_id=subject[0], subject_name=subject[1]
        )
        if not reader.shows_spend:
            items = [replace(item, used=None, fraction=reader.share(item.fraction)) for item in items]
        if items or now >= month.end:
            return items
        crossing = _projected_crossing(judged, now)
        if not reader.shows_spend and crossing is not None:
            # And to the day, so the moment it rolls over says no more than the share does.
            crossing = crossing.replace(hour=0, minute=0, second=0, microsecond=0)
        if crossing is None:
            return []
        return [
            _item(
                "budget_pace",
                "warn",
                *subject,
                used=standing.used if reader.shows_spend else None,
                limit=standing.limit,
                fraction=reader.share(standing.fraction),
                at=crossing,
            )
        ]

    async def _manages_spend(self, identity: TenancyUser, organization: Organization) -> bool:
        """Whether this caller may see their organization's spend ceilings.

        Asked rather than required: the summary answers 200 for everyone and
        leaves the field out, because a member's overview is a valid page that
        simply has no ceiling strip on it. The refusal is the ceilings route's
        own, so the two cannot disagree about who may read a ceiling.
        """

        try:
            await self._organizations.require_active_organization_management_access(
                user=identity,
                organization=organization,
            )
        except NotAuthorizedError:
            return False
        return True


def _allowed_scope(asked: OverviewScope, *, reader: WorkspaceReader | None, manages_spend: bool) -> OverviewScope:
    """The scope this caller may read: the one asked, or ``you``.

    The organization is an organization owner's or admin's, the line the
    ceilings route draws. A workspace is for whoever its ``reader`` lets read
    its totals, the line the usage reads draw.
    """

    if asked == "organization":
        return "organization" if manages_spend else "you"
    if asked == "workspace" and reader is not None and reader.reads_workspace_totals:
        return "workspace"
    return "you"


@dataclass(frozen=True)
class _Standing:
    """A ceiling as the request gate would read it at ``now``: its window, settled spend and holds."""

    limit: float
    settled: float
    reserved: float
    start: datetime | None
    end: datetime | None

    @property
    def used(self) -> float:
        return self.settled + self.reserved

    @property
    def fraction(self) -> float:
        # A zero cap admits nothing, so anything counted against it is all of it.
        if self.limit > 0:
            return self.used / self.limit
        return 1.0 if self.used > 0 else 0.0


def _standing(ceiling: Ceiling, now: datetime) -> _Standing:
    """Read a ceiling the way the gate's roll would leave it, as the workspace budget surface does.

    A period rolls only when a request next reaches the gate, so until then a
    ceiling whose window closed still holds the last window's spend. Read
    through :func:`effective_period`: the rolled window, nothing settled yet,
    and the holds, which survive a roll. An alignment the roll cannot read keeps
    the stored window, as the roll does.
    """

    try:
        rolled = effective_period(ceiling.period_end, now, duration=ceiling.duration, alignment=ceiling.alignment)
    except ValueError:
        rolled = None
    if rolled is None:
        start, end, settled = ceiling.period_start, ceiling.period_end, ceiling.current_spend
    else:
        start, end, settled = rolled[0], rolled[1], 0.0
    return _Standing(
        limit=ceiling.limit,
        settled=settled,
        reserved=ceiling.reserved_spend,
        start=utc_bound(start),
        end=utc_bound(end),
    )


def _candidates(now: datetime) -> Candidates:
    return Candidates(
        limit=ATTENTION_CANDIDATES,
        warn_fraction=BUDGET_WARN,
        expiring_after=now,
        expiring_before=now + KEY_EXPIRY_NOTICE,
    )


def _item(
    kind: AttentionKind,
    severity: Literal["alert", "warn"],
    subject_id: str | None,
    subject_name: str | None,
    *,
    used: float | None = None,
    limit: float | None = None,
    fraction: float | None = None,
    at: datetime | None = None,
    count: int | None = None,
) -> AttentionItem:
    return AttentionItem(
        kind=kind,
        severity=severity,
        subject_id=subject_id,
        subject_name=subject_name,
        used=used,
        limit=limit,
        fraction=fraction,
        at=at,
        count=count,
    )


def _limit_items(
    standing: _Standing,
    *,
    over: AttentionKind,
    near: AttentionKind,
    subject_id: str,
    subject_name: str | None,
) -> list[AttentionItem]:
    """An over or near item for one ceiling, or nothing while it is comfortable."""

    if standing.fraction < BUDGET_WARN:
        return []
    is_over = standing.fraction >= 1
    return [
        _item(
            over if is_over else near,
            "alert" if is_over else "warn",
            subject_id,
            subject_name,
            used=standing.used,
            limit=standing.limit,
            fraction=standing.fraction,
        )
    ]


def _as_shared(standing: _Standing, reader: WorkspaceReader) -> _Standing:
    """The standing as a reader who sees only the share knows it: the rounded share of the cap, settled.

    Holds are not taken off, as the real pace does, because the exact holds
    would move the projection with other people's requests in flight. Counting
    them makes this pace a little early, and makes it move only when the share
    the reader already sees does.
    """

    used = (reader.share(standing.fraction) or 0.0) * standing.limit
    return replace(standing, settled=used, reserved=0.0)


def _projected_crossing(standing: _Standing, now: datetime) -> datetime | None:
    """When settled spend at its pace so far passes the cap, if that lands before the period resets.

    Holds are left out: they are in-flight estimates, not a rate. A ceiling
    that never resets has no period to project across, and one barely into its
    period has too little run to project from, so the pace waits for
    ``PACE_MIN_ELAPSED`` or ``PACE_MIN_SHARE`` of the period, whichever is longer.
    Asked only of a ceiling that is not yet near its cap.
    """

    if standing.start is None or standing.end is None or standing.settled <= 0:
        return None
    elapsed = now - standing.start
    if elapsed < max(PACE_MIN_ELAPSED, (standing.end - standing.start) * PACE_MIN_SHARE):
        return None
    # Decided in seconds first: a tiny spend against a large cap projects a
    # crossing far past any date ``datetime`` can hold.
    to_cap = elapsed.total_seconds() * (standing.limit / standing.settled)
    if to_cap >= (standing.end - standing.start).total_seconds():
        return None
    return standing.start + timedelta(seconds=to_cap)


def _error_rate(requests: int, failures: int) -> list[AttentionItem]:
    """The month's failure rate in the scope, when it is high enough over enough requests to mean something."""

    if requests < ERROR_RATE_MIN_REQUESTS or failures / requests < ERROR_RATE_ALERT:
        return []
    return [_item("error_rate", "alert", None, None, fraction=failures / requests, count=failures)]


def _limit_columns(ceiling: Ceiling | None, now: datetime) -> tuple[float | None, float | None, datetime | None]:
    if ceiling is None:
        return None, None, None
    standing = _standing(ceiling, now)
    return standing.limit, standing.used, standing.end


def _key_row(key: KeySpend, *, mine: str, now: datetime) -> LimitRow:
    limit, limit_spent, period_end = _limit_columns(key.ceiling, now)
    return LimitRow(
        id=key.id,
        name=key.name,
        owner_name=key.owner_name,
        is_mine=key.user_id == mine,
        spent=key.billed,
        limit=limit,
        limit_spent=limit_spent,
        period_end=period_end,
        last_used_at=key.last_used_at,
        expires_at=key.expires_at,
        is_subscription=key.rows > 0 and key.served_rows == 0,
    )


def _workspace_row(ws: WorkspaceSpend, now: datetime) -> LimitRow:
    limit, limit_spent, period_end = _limit_columns(ws.ceiling, now)
    return LimitRow(
        id=str(ws.id),
        name=ws.name,
        owner_name=None,
        is_mine=False,
        spent=ws.billed,
        limit=limit,
        limit_spent=limit_spent,
        period_end=period_end,
        last_used_at=ws.last_used_at,
        expires_at=None,
        is_subscription=False,
    )
