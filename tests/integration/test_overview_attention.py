"""The overview's month, scope, needs-attention list and limits rail.

At the service layer for the same reason ``test_overview_endpoint.py`` gives:
the API can only act as the deployment's one superuser operator, and most of
what is under test here is what a member or a workspace manager may read. The
clock is passed in, so the month and the pace projection are fixed.

The HTTP surface is covered at the end: month parsing, the future-month
refusal and the fields the page reads.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from gateway.core.config import API_ROOT, GatewayConfig
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import WorkspaceTotalsHiddenError
from gateway.models.api_keys import APIKey
from gateway.models.budgets import ALIGN_MONTH, ALIGN_WEEK, SCOPE_API_TOKEN, SCOPE_WORKSPACE, Budget, ScopedBudget
from gateway.models.platform import RuntimeSetting
from gateway.models.tenancy import Organization, User, Workspace
from gateway.models.usage import UsageLog
from gateway.models.users import User as ApiUser
from gateway.repositories.overview.overview_repository import OverviewRepository
from gateway.repositories.tenancy import (
    OrganizationMemberRepository,
    OrganizationRepository,
    UserRepository,
    WorkspaceMemberRepository,
    WorkspaceRepository,
)
from gateway.repositories.usage import UsageReadRepository, UsageRollupRepository, UsageSummaryRepository
from gateway.services.model_discovery_service import ProviderDiscovery, get_model_cache
from gateway.services.organizations import UsageReach
from gateway.services.overview.overview_service import Month, OverviewService, OverviewSummary
from gateway.services.tenancy.deployment_user_service import DeploymentUserService
from gateway.services.tenancy.organization_service import OrganizationService
from gateway.services.tenancy.provisioning_service import BOOTSTRAP_IDENTITY_KEY
from gateway.services.tenancy.workspace_listener import NullWorkspaceListener
from gateway.services.tenancy.workspace_service import WorkspaceService
from gateway.services.usage import UsageReadService

from .tenancy_helpers import hide_totals, membership_writes, share_totals, visibility_service

NOW = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)
JULY = Month.current(NOW)
IN_JULY = datetime(2026, 7, 10, 9, 0, tzinfo=UTC)


# =============================================================================
# Fixtures
# =============================================================================


async def _organization(db: AsyncSession, slug: str) -> Organization:
    return await OrganizationRepository(db).create_organization(name=slug.title(), slug=slug, created_by_user_id=None)


async def _person(
    db: AsyncSession, organization: Organization, *, role: str, name: str, superuser: bool = False
) -> User:
    """A sign-in identity, its organization membership, and the billing user its keys attach to."""

    user = await UserRepository(db).create_local_identity(
        full_name=name, active_organization_id=organization.id, is_superuser=superuser
    )
    await OrganizationMemberRepository(db).create_membership(
        organization_id=organization.id, user_id=user.id, role=role
    )
    db.add(ApiUser(user_id=str(user.id), alias=name))
    await db.flush()
    return user


async def _workspace(db: AsyncSession, organization: Organization, name: str, owner: User) -> Workspace:
    workspace = await WorkspaceRepository(db).create_workspace(
        name=name, organization_id=organization.id, created_by_user_id=owner.id
    )
    await WorkspaceMemberRepository(db).create(workspace_id=workspace.id, user_id=owner.id, role="owner")
    return workspace


async def _join(db: AsyncSession, workspace: Workspace, user: User) -> None:
    await WorkspaceMemberRepository(db).create(workspace_id=workspace.id, user_id=user.id, role="member")


def _key(db: AsyncSession, workspace: Workspace, owner: User, key_id: str, **fields: Any) -> None:
    db.add(
        APIKey(
            id=key_id,
            key_hash=f"hash-{key_id}",
            key_name=fields.pop("name", key_id),
            workspace_id=workspace.id,
            user_id=str(owner.id),
            is_active=True,
            **fields,
        )
    )


def _usage(db: AsyncSession, workspace: Workspace, *, count: int = 1, **fields: Any) -> None:
    for _ in range(count):
        row: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "workspace_id": workspace.id,
            "timestamp": IN_JULY,
            "model": "gpt-4",
            "provider": "openai",
            "endpoint": "/v1/chat/completions",
            "source": "gateway",
            "cost": 1.0,
            "status": "success",
        }
        row.update(fields)
        db.add(UsageLog(**row))


def _ceiling(
    db: AsyncSession,
    organization: Organization,
    *,
    scope_type: str,
    scope_id: str,
    limit: float,
    spent: float,
    reserved: float = 0,
    period_start: datetime | None = None,
    period_end: datetime | None = None,
    alignment: str | None = None,
) -> None:
    budget_id = f"b-{uuid.uuid4().hex[:8]}"
    db.add(
        Budget(
            budget_id=budget_id,
            name="Cap",
            max_budget=Decimal(str(limit)),
            organization_id=organization.id,
            reset_alignment=alignment,
        )
    )
    db.add(
        ScopedBudget(
            id=f"sb-{budget_id}",
            scope_type=scope_type,
            scope_id=scope_id,
            budget_id=budget_id,
            name=None,
            current_spend=Decimal(str(spent)),
            reserved_spend=Decimal(str(reserved)),
            period_start=period_start,
            period_end=period_end,
        )
    )


def _usage_reads(db: AsyncSession) -> UsageReadService:
    uow = UnitOfWork(db)
    repositories = UsageReadRepository(uow), UsageSummaryRepository(uow), UsageRollupRepository(uow)
    return UsageReadService(uow, *repositories, asyncio.Semaphore(2))


def _service(db: AsyncSession, config: GatewayConfig | None = None) -> OverviewService:
    return OverviewService(
        OverviewRepository(db),
        OrganizationService(db, membership_listener=None, workspace_listener=NullWorkspaceListener()),
        DeploymentUserService(db),
        WorkspaceService(db, **membership_writes(db)),
        visibility_service(db),
        config or GatewayConfig(),
        UnitOfWork(db),
        asyncio.Semaphore(2),
        _usage_reads(db),
    )


async def _summary(
    db: AsyncSession,
    identity: User,
    *,
    workspace: Workspace | None = None,
    scope: Any = "workspace",
    month: Month = JULY,
    now: datetime = NOW,
    config: GatewayConfig | None = None,
) -> OverviewSummary:
    await db.flush()
    return await _service(db, config).summary(
        identity=identity,
        workspace_id=workspace.id if workspace else None,
        month=month,
        scope=scope,
        now=now,
    )


def _kinds(summary: OverviewSummary) -> list[str]:
    return [item.kind for item in summary.attention]


def _item(summary: OverviewSummary, kind: str) -> Any:
    found = [item for item in summary.attention if item.kind == kind]
    assert len(found) == 1, _kinds(summary)
    return found[0]


async def _team(db: AsyncSession, slug: str) -> tuple[Organization, User, User, User, Workspace]:
    """An organization with an owner, a member, a second member, and one workspace all three are in."""

    organization = await _organization(db, slug)
    owner = await _person(db, organization, role="owner", name="Owner")
    member = await _person(db, organization, role="member", name="Member")
    other = await _person(db, organization, role="member", name="Other")
    workspace = await _workspace(db, organization, "Engineering", owner)
    await _join(db, workspace, member)
    await _join(db, workspace, other)
    return organization, owner, member, other, workspace


# =============================================================================
# The month
# =============================================================================


def test_the_current_month_counts_the_days_so_far() -> None:
    assert JULY.start == datetime(2026, 7, 1, tzinfo=UTC)
    assert JULY.end == datetime(2026, 8, 1, tzinfo=UTC)
    assert (JULY.elapsed_days, JULY.days) == (20, 31)


def test_a_past_month_has_run_all_its_days() -> None:
    february = Month.of(2026, 2, NOW)

    assert february.end == datetime(2026, 3, 1, tzinfo=UTC)
    assert (february.elapsed_days, february.days) == (28, 28)


@pytest.mark.asyncio
async def test_a_past_month_reads_only_its_own_usage(async_db: AsyncSession) -> None:
    organization, owner, _, _, workspace = await _team(async_db, "acme-past")
    _key(async_db, workspace, owner, "sk-past")
    await async_db.flush()
    _usage(async_db, workspace, api_key_id="sk-past", cost=3.0, timestamp=datetime(2026, 6, 15, tzinfo=UTC))
    _usage(async_db, workspace, api_key_id="sk-past", cost=5.0)

    june = await _summary(async_db, owner, workspace=workspace, month=Month.of(2026, 6, NOW))
    july = await _summary(async_db, owner, workspace=workspace)

    assert june.limits.rows[0].spent == 3.0
    assert july.limits.rows[0].spent == 5.0


# =============================================================================
# Scope
# =============================================================================


@pytest.mark.asyncio
async def test_a_superuser_member_reads_everyone_whatever_the_workspace_shares(async_db: AsyncSession) -> None:
    """A deployment operator who is only a member of the workspace still reads every row in it."""

    _, _, member, other, workspace = await _team(async_db, "acme-reach-superuser")
    member.is_superuser = True
    await hide_totals(async_db, workspace)
    visibility = visibility_service(async_db)

    reach = await visibility.usage_reach(
        user=member, workspace=workspace, workspace_totals=True, breakdowns=["user"], filters=["user_id"]
    )

    assert reach == UsageReach("everyone")
    with pytest.raises(WorkspaceTotalsHiddenError):
        await visibility.usage_reach(
            user=other, workspace=workspace, workspace_totals=True, breakdowns=["model"], filters=[]
        )


@pytest.mark.asyncio
async def test_the_bootstrap_operator_reads_everyone_though_not_a_superuser(async_db: AsyncSession) -> None:
    """The deployment's bootstrap identity operates it, superuser flag or not, as everywhere else."""

    _, _, member, _, workspace = await _team(async_db, "acme-reach-bootstrap")
    assert not member.is_superuser
    async_db.add(RuntimeSetting(key=BOOTSTRAP_IDENTITY_KEY, value=str(member.id)))
    await hide_totals(async_db, workspace)
    await async_db.flush()

    reach = await visibility_service(async_db).usage_reach(
        user=member, workspace=workspace, workspace_totals=True, breakdowns=["user"], filters=["user_id"]
    )

    assert reach == UsageReach("everyone")


@pytest.mark.asyncio
async def test_a_member_asking_for_the_organization_reads_their_own(async_db: AsyncSession) -> None:
    _, _, member, _, workspace = await _team(async_db, "acme-fallback-org")

    assert (await _summary(async_db, member, workspace=workspace, scope="organization")).scope == "you"


@pytest.mark.asyncio
async def test_a_member_reads_the_workspace_while_its_managers_share_its_totals(async_db: AsyncSession) -> None:
    _, _, member, _, workspace = await _team(async_db, "acme-shown")
    await share_totals(async_db, workspace)

    summary = await _summary(async_db, member, workspace=workspace, scope="workspace")

    assert summary.scope == "workspace"
    assert summary.visibility is not None and summary.visibility.members_see_workspace_totals is True


@pytest.mark.asyncio
async def test_a_member_asking_for_a_workspace_that_hides_its_totals_reads_their_own(async_db: AsyncSession) -> None:
    _, _, member, _, workspace = await _team(async_db, "acme-fallback")
    await hide_totals(async_db, workspace)

    summary = await _summary(async_db, member, workspace=workspace, scope="workspace")

    assert summary.scope == "you"
    assert summary.visibility is not None and summary.visibility.members_see_workspace_totals is False


@pytest.mark.asyncio
async def test_a_workspace_owner_reads_a_workspace_that_hides_its_totals(async_db: AsyncSession) -> None:
    """The setting is about members; the people who manage the workspace read it whole."""

    _, owner, member, _, workspace = await _team(async_db, "acme-hidden-owner")
    _key(async_db, workspace, member, "sk-member")
    await hide_totals(async_db, workspace)

    summary = await _summary(async_db, owner, workspace=workspace, scope="workspace")

    assert summary.scope == "workspace"
    assert [row.id for row in summary.limits.rows] == ["sk-member"]


@pytest.mark.asyncio
async def test_a_workspace_owner_reads_the_workspace_but_not_the_organization(async_db: AsyncSession) -> None:
    """Managing one workspace is not authority over the organization's spend."""

    organization = await _organization(async_db, "acme-ws-owner")
    await _person(async_db, organization, role="owner", name="Owner")
    lead = await _person(async_db, organization, role="member", name="Lead")
    workspace = await _workspace(async_db, organization, "Team", lead)

    assert (await _summary(async_db, lead, workspace=workspace, scope="workspace")).scope == "workspace"
    assert (await _summary(async_db, lead, workspace=workspace, scope="organization")).scope == "you"


@pytest.mark.asyncio
async def test_an_admin_reads_the_organization(async_db: AsyncSession) -> None:
    organization = await _organization(async_db, "acme-org-admin")
    admin = await _person(async_db, organization, role="admin", name="Admin")

    summary = await _summary(async_db, admin, scope="organization")

    assert summary.scope == "organization"
    assert summary.limits.kind == "workspaces"


@pytest.mark.asyncio
async def test_the_workspace_scope_without_a_workspace_reads_the_callers_own(async_db: AsyncSession) -> None:
    organization = await _organization(async_db, "acme-no-ws")
    owner = await _person(async_db, organization, role="owner", name="Owner")

    assert (await _summary(async_db, owner, scope="workspace")).scope == "you"


# =============================================================================
# The rail
# =============================================================================


@pytest.mark.asyncio
async def test_a_member_sees_only_their_own_keys_with_their_limits(async_db: AsyncSession) -> None:
    organization, _, member, other, workspace = await _team(async_db, "acme-own-keys")
    _key(async_db, workspace, member, "sk-mine")
    _key(async_db, workspace, other, "sk-theirs")
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-mine", limit=50, spent=10)
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-theirs", limit=20, spent=20)

    summary = await _summary(async_db, member, workspace=workspace, scope="you")

    assert summary.limits.kind == "keys"
    assert [row.id for row in summary.limits.rows] == ["sk-mine"]
    row = summary.limits.rows[0]
    assert (row.is_mine, row.limit, row.limit_spent, row.owner_name) == (True, 50.0, 10.0, "Member")
    # Their key is over its limit; neither the row nor the alert reaches a member.
    assert "key_over_limit" not in _kinds(summary)


@pytest.mark.asyncio
async def test_a_member_reading_the_workspace_totals_sees_no_key_in_the_rail(async_db: AsyncSession) -> None:
    """The workspace's keys are other people's, so the rail is empty; the member's own key still reaches attention."""

    organization, _, member, other, workspace = await _team(async_db, "acme-member-rail")
    await share_totals(async_db, workspace)
    _key(async_db, workspace, member, "sk-mine")
    _key(async_db, workspace, other, "sk-theirs")
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-mine", limit=10, spent=10)
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-theirs", limit=20, spent=20)
    await async_db.flush()
    _usage(async_db, workspace, api_key_id="sk-theirs", cost=5.0)

    summary = await _summary(async_db, member, workspace=workspace, scope="workspace")

    assert summary.scope == "workspace"
    assert (summary.limits.kind, summary.limits.rows) == ("keys", [])
    over = [item.subject_id for item in summary.attention if item.kind == "key_over_limit"]
    assert over == ["sk-mine"]


@pytest.mark.asyncio
async def test_a_manager_sees_the_most_billed_keys_in_the_workspace(async_db: AsyncSession) -> None:
    _, owner, member, _, workspace = await _team(async_db, "acme-top-keys")
    for index in range(9):
        _key(async_db, workspace, member if index % 2 else owner, f"sk-{index}")
    await async_db.flush()
    for index in range(9):
        _usage(async_db, workspace, api_key_id=f"sk-{index}", cost=float(index + 1))

    summary = await _summary(async_db, owner, workspace=workspace, scope="workspace")

    assert summary.scope == "workspace"
    assert [row.id for row in summary.limits.rows] == [f"sk-{index}" for index in range(8, 0, -1)]
    by_id = {row.id: row for row in summary.limits.rows}
    assert (by_id["sk-8"].is_mine, by_id["sk-8"].owner_name) == (True, "Owner")
    assert (by_id["sk-7"].is_mine, by_id["sk-7"].owner_name) == (False, "Member")


@pytest.mark.asyncio
async def test_the_callers_own_rail_is_capped_too(async_db: AsyncSession) -> None:
    _, _, member, _, workspace = await _team(async_db, "acme-own-cap")
    for index in range(9):
        _key(async_db, workspace, member, f"sk-own-{index}")

    summary = await _summary(async_db, member, workspace=workspace, scope="you")

    assert len(summary.limits.rows) == 8


@pytest.mark.asyncio
async def test_the_organization_rail_lists_workspaces_with_their_ceilings(async_db: AsyncSession) -> None:
    organization, owner, _, _, engineering = await _team(async_db, "acme-org-rail")
    research = await _workspace(async_db, organization, "Research", owner)
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(research.id), limit=200, spent=30)
    _usage(async_db, engineering, cost=2.0)
    _usage(async_db, research, cost=9.0)

    summary = await _summary(async_db, owner, scope="organization")

    rows = summary.limits.rows
    assert [row.name for row in rows] == ["Research", "Engineering"]
    assert (rows[0].spent, rows[0].limit, rows[0].limit_spent) == (9.0, 200.0, 30.0)
    assert rows[1].limit is None


@pytest.mark.asyncio
async def test_a_workspace_row_says_when_it_last_served_a_request_in_the_month(async_db: AsyncSession) -> None:
    organization, owner, _, _, engineering = await _team(async_db, "acme-org-last-used")
    research = await _workspace(async_db, organization, "Research", owner)
    latest = datetime(2026, 7, 18, 16, 30, tzinfo=UTC)
    _usage(async_db, engineering, timestamp=IN_JULY)
    _usage(async_db, engineering, timestamp=latest)
    _usage(async_db, research, timestamp=datetime(2026, 6, 30, 23, 0, tzinfo=UTC))

    summary = await _summary(async_db, owner, scope="organization")

    by_name = {row.name: row for row in summary.limits.rows}
    assert by_name["Engineering"].last_used_at == latest
    assert by_name["Research"].last_used_at is None


@pytest.mark.asyncio
async def test_spent_is_what_the_deployment_billed_not_imported_usage(async_db: AsyncSession) -> None:
    """Imported usage was paid for elsewhere, so it is not this month's bill."""

    _, owner, _, _, workspace = await _team(async_db, "acme-billed")
    _key(async_db, workspace, owner, "sk-mixed")
    _key(async_db, workspace, owner, "sk-imported")
    await async_db.flush()
    _usage(async_db, workspace, api_key_id="sk-mixed", cost=4.0)
    _usage(async_db, workspace, api_key_id="sk-mixed", cost=6.0, source="claude_code")
    _usage(async_db, workspace, api_key_id="sk-imported", cost=7.0, source="claude_code")

    summary = await _summary(async_db, owner, workspace=workspace, scope="workspace")

    by_id = {row.id: row for row in summary.limits.rows}
    assert (by_id["sk-mixed"].spent, by_id["sk-mixed"].is_subscription) == (4.0, False)
    assert (by_id["sk-imported"].spent, by_id["sk-imported"].is_subscription) == (0.0, True)


@pytest.mark.asyncio
async def test_a_ceiling_whose_period_ran_out_reads_as_the_roll_will_leave_it(async_db: AsyncSession) -> None:
    """The counters roll on the next request, so the stale spend is last period's.

    Read as ``GET /workspaces/{id}/budget`` reads it: the window the roll moves
    it into, nothing settled yet, and the holds, which survive a roll.
    """

    organization, owner, _, _, workspace = await _team(async_db, "acme-rolled")
    _key(async_db, workspace, owner, "sk-rolled")
    _ceiling(
        async_db,
        organization,
        scope_type=SCOPE_API_TOKEN,
        scope_id="sk-rolled",
        limit=10,
        spent=10,
        reserved=1,
        period_start=datetime(2026, 6, 1, tzinfo=UTC),
        period_end=datetime(2026, 7, 1, tzinfo=UTC),
        alignment=ALIGN_MONTH,
    )

    summary = await _summary(async_db, owner, workspace=workspace, scope="you")

    row = summary.limits.rows[0]
    assert (row.limit_spent, row.period_end) == (1.0, JULY.end)
    assert "key_over_limit" not in _kinds(summary)


@pytest.mark.asyncio
async def test_the_tightest_ceiling_reads_as_the_roll_will_leave_it(async_db: AsyncSession) -> None:
    """A ceiling over last period, with no request since its reset, is not over now."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-tightest-rolled")
    _ceiling(
        async_db,
        organization,
        scope_type=SCOPE_WORKSPACE,
        scope_id=str(workspace.id),
        limit=10,
        spent=12,
        reserved=1,
        period_start=datetime(2026, 6, 1, tzinfo=UTC),
        period_end=datetime(2026, 7, 1, tzinfo=UTC),
        alignment=ALIGN_MONTH,
    )

    summary = await _summary(async_db, owner, scope="organization")

    assert summary.ceilings is not None
    assert summary.ceilings.over_count == 0
    assert summary.ceilings.worst is not None
    assert summary.ceilings.worst.spent == 1.0


@pytest.mark.asyncio
async def test_a_ceiling_on_an_alignment_the_roll_cannot_read_keeps_its_stored_window(async_db: AsyncSession) -> None:
    """The gate's roll leaves such a ceiling as it is, so the read does too."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-odd-alignment")
    _key(async_db, workspace, owner, "sk-odd")
    june_end = datetime(2026, 7, 1, tzinfo=UTC)
    _ceiling(
        async_db,
        organization,
        scope_type=SCOPE_API_TOKEN,
        scope_id="sk-odd",
        limit=10,
        spent=5,
        period_start=datetime(2026, 6, 1, tzinfo=UTC),
        period_end=june_end,
        alignment="fortnightly",
    )

    summary = await _summary(async_db, owner, workspace=workspace, scope="you")

    row = summary.limits.rows[0]
    assert (row.limit_spent, row.period_end) == (5.0, june_end)


@pytest.mark.asyncio
async def test_a_key_in_another_organization_never_reaches_the_rail(async_db: AsyncSession) -> None:
    """One person in two organizations, with a key in each: only the active one's answers.

    A key carries no organization of its own, so this is the workspace join
    standing in for one; without it the owner filter alone would list both.
    """

    mine = await _organization(async_db, "acme-iso-mine")
    theirs = await _organization(async_db, "acme-iso-theirs")
    person = await _person(async_db, mine, role="owner", name="Person")
    await OrganizationMemberRepository(async_db).create_membership(
        organization_id=theirs.id, user_id=person.id, role="owner"
    )
    _key(async_db, await _workspace(async_db, mine, "Mine", person), person, "sk-iso-mine")
    _key(async_db, await _workspace(async_db, theirs, "Theirs", person), person, "sk-iso-theirs")

    summary = await _summary(async_db, person, scope="you")

    assert [row.id for row in summary.limits.rows] == ["sk-iso-mine"]


@pytest.mark.asyncio
async def test_a_ceiling_another_organization_holds_on_the_same_scope_id_is_not_read(async_db: AsyncSession) -> None:
    """A scope id is only a string, so the ceiling read is bound to the caller's organization too."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-iso-cap-mine")
    other = await _organization(async_db, "acme-iso-cap-theirs")
    _key(async_db, workspace, owner, "sk-iso-cap")
    _ceiling(async_db, other, scope_type=SCOPE_API_TOKEN, scope_id="sk-iso-cap", limit=1, spent=5)
    _ceiling(async_db, other, scope_type=SCOPE_WORKSPACE, scope_id=str(workspace.id), limit=1, spent=5)

    summary = await _summary(async_db, owner, workspace=workspace)

    assert summary.limits.rows[0].limit is None
    assert summary.attention == []


# =============================================================================
# Needs attention
# =============================================================================


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("spent", "expected"),
    [(100, "budget_over"), (85, "budget_near"), (20, None)],
)
async def test_the_workspace_ceiling_is_judged_for_everyone_in_it(
    async_db: AsyncSession, spent: float, expected: str | None
) -> None:
    """A member may read the workspace budget, so its state reaches them too."""

    organization, _, member, _, workspace = await _team(async_db, f"acme-budget-{spent}")
    await share_totals(async_db, workspace)
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(workspace.id), limit=100, spent=spent)

    summary = await _summary(async_db, member, workspace=workspace, scope="you")

    budget_kinds = [kind for kind in _kinds(summary) if kind.startswith("budget_")]
    assert budget_kinds == ([expected] if expected else [])
    if expected:
        item = _item(summary, expected)
        assert (item.subject_id, item.subject_name, item.used, item.limit) == (
            str(workspace.id),
            "Engineering",
            float(spent),
            100.0,
        )
        assert item.severity == ("alert" if expected == "budget_over" else "warn")


@pytest.mark.asyncio
async def test_a_zero_ceiling_with_anything_spent_against_it_is_over(async_db: AsyncSession) -> None:
    """A zero cap admits nothing, so any spend counted against it is all of it."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-zero-cap")
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(workspace.id), limit=0, spent=0.5)

    summary = await _summary(async_db, owner, workspace=workspace)

    item = _item(summary, "budget_over")
    assert (item.fraction, item.severity) == (1.0, "alert")


# A Thursday noon, three and a half days into the ISO week of July 20.
PACE_NOW = datetime(2026, 7, 23, 12, 0, tzinfo=UTC)
WEEK = (datetime(2026, 7, 20, tzinfo=UTC), datetime(2026, 7, 27, tzinfo=UTC))


def _weekly(
    db: AsyncSession, organization: Organization, workspace: Workspace, *, spent: float, reserved: float = 0
) -> None:
    _ceiling(
        db,
        organization,
        scope_type=SCOPE_WORKSPACE,
        scope_id=str(workspace.id),
        limit=100,
        spent=spent,
        reserved=reserved,
        period_start=WEEK[0],
        period_end=WEEK[1],
        alignment=ALIGN_WEEK,
    )


@pytest.mark.asyncio
async def test_budget_pace_projects_across_the_ceilings_own_period(async_db: AsyncSession) -> None:
    """70 of 100 settled in 3.5 days of a week is 100 at 5 days: Saturday the 25th.

    The holds are left out of the pace (with them it would be Friday the 24th),
    and the period is the ceiling's week, not the calendar month, which would
    project into August and say nothing.
    """

    organization, owner, _, _, workspace = await _team(async_db, "acme-pace")
    _weekly(async_db, organization, workspace, spent=70, reserved=5)

    summary = await _summary(async_db, owner, workspace=workspace, now=PACE_NOW)

    item = _item(summary, "budget_pace")
    assert item.at == datetime(2026, 7, 25, tzinfo=UTC)
    assert (item.severity, item.used, item.limit) == ("warn", 75.0, 100.0)


@pytest.mark.asyncio
async def test_budget_pace_is_quiet_when_the_crossing_lands_after_the_reset(async_db: AsyncSession) -> None:
    organization, owner, _, _, workspace = await _team(async_db, "acme-slow")
    _weekly(async_db, organization, workspace, spent=40)

    assert "budget_pace" not in _kinds(await _summary(async_db, owner, workspace=workspace, now=PACE_NOW))


@pytest.mark.asyncio
async def test_budget_pace_is_quiet_when_a_trickle_projects_past_any_date(async_db: AsyncSession) -> None:
    """A tiny spend against the cap projects a crossing no date can hold, which is no crossing."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-trickle")
    _weekly(async_db, organization, workspace, spent=0.0001)

    assert "budget_pace" not in _kinds(await _summary(async_db, owner, workspace=workspace, now=PACE_NOW))


@pytest.mark.asyncio
async def test_budget_pace_waits_for_enough_of_the_period_to_project_from(async_db: AsyncSession) -> None:
    """Half a day into a week is under the one-day minimum, however steep the start."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-pace-early")
    _weekly(async_db, organization, workspace, spent=50)

    early = await _summary(async_db, owner, workspace=workspace, now=datetime(2026, 7, 20, 12, 0, tzinfo=UTC))

    assert "budget_pace" not in _kinds(early)


@pytest.mark.asyncio
async def test_budget_pace_says_nothing_once_the_ceiling_is_already_spent(async_db: AsyncSession) -> None:
    """Over is the alert; a projected crossing of a line already crossed adds nothing."""

    organization, owner, _, _, workspace = await _team(async_db, "acme-pace-spent")
    _weekly(async_db, organization, workspace, spent=100)

    summary = await _summary(async_db, owner, workspace=workspace, now=PACE_NOW)

    assert "budget_over" in _kinds(summary)
    assert "budget_pace" not in _kinds(summary)


@pytest.mark.asyncio
async def test_budget_pace_is_only_for_the_current_month(async_db: AsyncSession) -> None:
    organization, owner, _, _, workspace = await _team(async_db, "acme-pace-past")
    _weekly(async_db, organization, workspace, spent=70)

    june = await _summary(async_db, owner, workspace=workspace, month=Month.of(2026, 6, PACE_NOW), now=PACE_NOW)

    assert "budget_pace" not in _kinds(june)


@pytest.mark.asyncio
async def test_the_organization_scope_judges_each_workspace_ceiling(async_db: AsyncSession) -> None:
    organization, owner, _, _, engineering = await _team(async_db, "acme-org-budgets")
    research = await _workspace(async_db, organization, "Research", owner)
    quiet = await _workspace(async_db, organization, "Quiet", owner)
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(engineering.id), limit=10, spent=12)
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(research.id), limit=10, spent=9)
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(quiet.id), limit=10, spent=1)

    summary = await _summary(async_db, owner, scope="organization")

    assert [(item.kind, item.subject_name) for item in summary.attention] == [
        ("budget_over", "Engineering"),
        ("budget_near", "Research"),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("spent", "expected"),
    [(5, "key_over_limit"), (4.2, "key_near_limit"), (1, None)],
)
async def test_a_key_ceiling_is_judged_for_its_owner(
    async_db: AsyncSession, spent: float, expected: str | None
) -> None:
    organization, _, member, _, workspace = await _team(async_db, f"acme-keycap-{int(spent * 10)}")
    _key(async_db, workspace, member, "sk-capped", name="Laptop")
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-capped", limit=5, spent=spent)

    summary = await _summary(async_db, member, workspace=workspace, scope="you")

    key_kinds = [kind for kind in _kinds(summary) if kind.startswith("key_")]
    assert key_kinds == ([expected] if expected else [])
    if expected:
        item = _item(summary, expected)
        assert (item.subject_id, item.subject_name, item.limit) == ("sk-capped", "Laptop", 5.0)


@pytest.mark.asyncio
async def test_a_manager_hears_about_every_key_in_the_workspace(async_db: AsyncSession) -> None:
    """Judged over every key in scope, not only the eight the rail lists."""

    organization, owner, member, _, workspace = await _team(async_db, "acme-keycap-all")
    for index in range(9):
        _key(async_db, workspace, owner, f"sk-big-{index}")
    _key(async_db, workspace, member, "sk-small")
    await async_db.flush()
    for index in range(9):
        _usage(async_db, workspace, api_key_id=f"sk-big-{index}", cost=10.0)
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-small", limit=1, spent=1)

    summary = await _summary(async_db, owner, workspace=workspace)

    assert "sk-small" not in [row.id for row in summary.limits.rows]
    assert _item(summary, "key_over_limit").subject_id == "sk-small"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("expires_in", "expected"),
    [(timedelta(days=3), True), (timedelta(days=10), False), (timedelta(days=-1), False)],
)
async def test_a_key_expiring_within_a_week_is_flagged(
    async_db: AsyncSession, expires_in: timedelta, expected: bool
) -> None:
    _, _, member, _, workspace = await _team(async_db, f"acme-expiry-{expires_in.days}")
    _key(async_db, workspace, member, "sk-expiring", expires_at=NOW + expires_in)

    summary = await _summary(async_db, member, workspace=workspace, scope="you")

    assert ("key_expiring" in _kinds(summary)) is expected
    if expected:
        assert _item(summary, "key_expiring").at == NOW + expires_in


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("requests", "failures", "expected"),
    [(20, 2, True), (19, 5, False), (30, 2, False)],
)
async def test_the_error_rate_needs_enough_requests_and_failures(
    async_db: AsyncSession, requests: int, failures: int, expected: bool
) -> None:
    _, owner, _, _, workspace = await _team(async_db, f"acme-errors-{requests}-{failures}")
    _usage(async_db, workspace, count=requests - failures)
    _usage(async_db, workspace, count=failures, status="error")
    # A recovered attempt is part of the request it served, not a failure or a request.
    _usage(async_db, workspace, count=10, status="absorbed")

    summary = await _summary(async_db, owner, workspace=workspace)

    assert ("error_rate" in _kinds(summary)) is expected
    if expected:
        item = _item(summary, "error_rate")
        assert (item.count, item.fraction, item.severity) == (failures, failures / requests, "alert")


@pytest.mark.asyncio
async def test_a_members_error_rate_counts_only_their_own_requests(async_db: AsyncSession) -> None:
    _, _, member, other, workspace = await _team(async_db, "acme-errors-mine")
    _usage(async_db, workspace, count=20, status="error", user_id=str(other.id))
    _usage(async_db, workspace, count=20, user_id=str(member.id))

    assert "error_rate" not in _kinds(await _summary(async_db, member, workspace=workspace, scope="you"))


@pytest.mark.asyncio
async def test_a_member_reading_the_workspace_totals_hears_the_workspaces_error_rate(async_db: AsyncSession) -> None:
    _, _, member, other, workspace = await _team(async_db, "acme-errors-workspace")
    await share_totals(async_db, workspace)
    _usage(async_db, workspace, count=20, status="error", user_id=str(other.id))
    _usage(async_db, workspace, count=20, user_id=str(member.id))

    item = _item(await _summary(async_db, member, workspace=workspace, scope="workspace"), "error_rate")

    assert (item.count, item.fraction) == (20, 0.5)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("spent", "kind"),
    [
        (100, "budget_over"),
        (85.1234, "budget_near"),
        # Judged on the share the member reads, so the kind agrees with the percent shown.
        (99.6, "budget_over"),
        (79.6, "budget_near"),
    ],
)
async def test_a_member_of_a_workspace_that_hides_its_totals_reads_the_budget_as_a_share(
    async_db: AsyncSession, spent: float, kind: str
) -> None:
    organization, owner, member, _, workspace = await _team(async_db, f"acme-hidden-budget-{spent}")
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(workspace.id), limit=100, spent=spent)
    await hide_totals(async_db, workspace)

    hidden = _item(await _summary(async_db, member, workspace=workspace, scope="you"), kind)

    # A whole percent, so the share times the cap does not give the spend back.
    assert (hidden.used, hidden.limit, hidden.fraction) == (None, 100.0, round(spent / 100, 2))
    managed = await _summary(async_db, owner, workspace=workspace, scope="you")
    exact = [item for item in managed.attention if item.kind in ("budget_over", "budget_near")]
    if spent >= 80:
        assert len(exact) == 1
        assert exact[0].used == pytest.approx(spent)
        assert exact[0].limit == 100.0
        assert exact[0].fraction == pytest.approx(spent / 100)
    else:
        assert exact == []


@pytest.mark.asyncio
async def test_budget_pace_hides_the_spend_from_a_member_of_a_workspace_that_hides_its_totals(
    async_db: AsyncSession,
) -> None:
    organization, _, member, _, workspace = await _team(async_db, "acme-hidden-pace")
    _weekly(async_db, organization, workspace, spent=60, reserved=5)
    await hide_totals(async_db, workspace)

    item = _item(await _summary(async_db, member, workspace=workspace, scope="you", now=PACE_NOW), "budget_pace")

    assert (item.used, item.limit, item.fraction) == (None, 100.0, 0.65)
    # 60 in 3.5 days crosses 100 at 20:00 on the 25th; a member reads only the day, since the
    # exact time, the cap and the period's start would give the spend back.
    assert item.at == datetime(2026, 7, 25, tzinfo=UTC)


@pytest.mark.asyncio
async def test_a_hidden_readers_pace_moves_only_with_the_share_they_already_read(async_db: AsyncSession) -> None:
    """Spends and holds that make one rounded share project one day, though their exact crossings differ.

    Each is 63% of 100 used: 57.6 settled with 5 held, 58.4 with 5, and 61.4 with
    1.6. Exactly, the first two cross either side of midnight on the 25th and the
    holds move the third, so a day taken from the exact figures would tell a
    member polling it which side of a boundary the spend, or someone's request
    in flight, is on. Read from the share alone, 63 used in 3.5 days crosses 100
    on the 25th for all three.
    """

    days = []
    for slug, spent, reserved in (
        ("acme-pace-low", 57.6, 5),
        ("acme-pace-high", 58.4, 5),
        ("acme-pace-held", 61.4, 1.6),
    ):
        organization, _, member, _, workspace = await _team(async_db, slug)
        _weekly(async_db, organization, workspace, spent=spent, reserved=reserved)
        await hide_totals(async_db, workspace)
        item = _item(await _summary(async_db, member, workspace=workspace, scope="you", now=PACE_NOW), "budget_pace")
        assert item.fraction == 0.63
        days.append(item.at)

    assert days == [datetime(2026, 7, 25, tzinfo=UTC)] * 3


@pytest.mark.asyncio
async def test_budget_pace_keeps_the_exact_crossing_for_a_manager_of_a_workspace_that_hides_its_totals(
    async_db: AsyncSession,
) -> None:
    organization, owner, _, _, workspace = await _team(async_db, "acme-hidden-pace-owner")
    _weekly(async_db, organization, workspace, spent=60, reserved=5)
    await hide_totals(async_db, workspace)

    item = _item(await _summary(async_db, owner, workspace=workspace, scope="you", now=PACE_NOW), "budget_pace")

    assert item.at == datetime(2026, 7, 25, 20, 0, tzinfo=UTC)


async def _statements(db: AsyncSession, identity: User, workspace: Workspace, scope: Any) -> int:
    """How many statements one summary runs."""

    await db.flush()
    count = 0

    def _counted(*_: Any) -> None:
        nonlocal count
        count += 1

    connection = (await db.connection()).sync_connection
    event.listen(connection, "before_cursor_execute", _counted)
    try:
        await _summary(db, identity, workspace=workspace, scope=scope)
    finally:
        event.remove(connection, "before_cursor_execute", _counted)
    return count


@pytest.mark.asyncio
async def test_the_setting_is_read_with_the_workspace_and_costs_no_statement(async_db: AsyncSession) -> None:
    """The setting is a column of the workspace row the summary already resolves.

    The same scope with the setting on and off, so the reads differ only in it.
    """

    _, _, member, _, workspace = await _team(async_db, "acme-statements")
    shown = await _statements(async_db, member, workspace, "you")
    await hide_totals(async_db, workspace)
    hidden = await _statements(async_db, member, workspace, "you")

    assert shown == hidden


@pytest.fixture
def provider_cache() -> Any:
    cache = get_model_cache()
    cache.clear()
    yield cache
    cache.clear()


@pytest.mark.asyncio
async def test_only_an_operator_hears_about_unreachable_providers(async_db: AsyncSession, provider_cache: Any) -> None:
    """Read from the discovery cache: a cached failure is said, and nothing is dialed for one never checked."""

    config = GatewayConfig(
        providers={
            "openai": {"api_key": "sk-test"},
            "vllm": {"api_key": "x"},
            "anthropic": {"api_key": "sk-test"},
            "mistral": {"api_key": "sk-test"},
        }
    )
    provider_cache.set("anthropic", [])
    for name, unsupported in (("openai", False), ("vllm", True)):
        provider_cache.set(name, [])
        provider_cache._store[name].result = ProviderDiscovery(
            provider=name, models=[], error="unreachable", discovery_unsupported=unsupported
        )
    organization = await _organization(async_db, "acme-providers")
    operator = await _person(async_db, organization, role="owner", name="Operator", superuser=True)
    owner = await _person(async_db, organization, role="owner", name="Owner")

    seen = await _summary(async_db, operator, config=config)
    unseen = await _summary(async_db, owner, config=config)

    assert [(item.kind, item.subject_id, item.severity) for item in seen.attention] == [
        ("provider_unreachable", "openai", "alert")
    ]
    # Never checked, so neither dialed nor reported.
    assert provider_cache.stale("mistral") is None
    assert unseen.attention == []


@pytest.mark.asyncio
async def test_alerts_come_before_warnings(async_db: AsyncSession) -> None:
    organization, _, member, _, workspace = await _team(async_db, "acme-order")
    _key(async_db, workspace, member, "sk-order-expiring", expires_at=NOW + timedelta(days=2))
    _key(async_db, workspace, member, "sk-order-over")
    _ceiling(async_db, organization, scope_type=SCOPE_API_TOKEN, scope_id="sk-order-over", limit=1, spent=2)
    _ceiling(async_db, organization, scope_type=SCOPE_WORKSPACE, scope_id=str(workspace.id), limit=100, spent=90)

    summary = await _summary(async_db, member, workspace=workspace, scope="you")

    assert _kinds(summary) == ["key_over_limit", "budget_near", "key_expiring"]


# =============================================================================
# The HTTP surface
# =============================================================================

_ENDPOINT = f"{API_ROOT}/overview"


def test_the_overview_reports_the_month_and_scope_it_read(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    response = client.get(_ENDPOINT, params={"month": "2026-02", "scope": "organization"}, headers=master_key_header)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["month"] == {
        "start": "2026-02-01T00:00:00Z",
        "end": "2026-03-01T00:00:00Z",
        "elapsed_days": 28,
        "days": 28,
    }
    assert body["scope"] == "organization"
    assert body["limits"]["kind"] == "workspaces"
    assert isinstance(body["attention"], list)
    # No workspace named, so there is no workspace visibility to report.
    assert body["visibility"] is None


def test_the_overview_says_whether_the_named_workspace_shares_its_totals(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    workspace_id = client.get(f"{API_ROOT}/workspaces", headers=master_key_header).json()["data"][0]["id"]
    hidden = client.patch(
        f"{API_ROOT}/workspaces/{workspace_id}/visibility",
        json={"members_see_workspace_totals": False},
        headers=master_key_header,
    )
    assert hidden.status_code == 200, hidden.text

    response = client.get(_ENDPOINT, params={"workspace_id": workspace_id}, headers=master_key_header)

    assert response.status_code == 200, response.text
    assert response.json()["visibility"] == {"members_see_workspace_totals": False}


def test_the_current_month_is_the_default(client: TestClient, master_key_header: dict[str, str]) -> None:
    before = datetime.now(UTC)
    body = client.get(_ENDPOINT, headers=master_key_header).json()
    after = datetime.now(UTC)

    # Either side of a month edge, the answer is the month one of the two clocks saw.
    assert body["month"]["start"] in {
        Month.current(before).start.isoformat().replace("+00:00", "Z"),
        Month.current(after).start.isoformat().replace("+00:00", "Z"),
    }


@pytest.mark.parametrize("month", ["2999-01", "9999-12", "0000-01", "2026-13", "2026-7", "july"])
def test_a_future_or_malformed_month_is_refused(
    client: TestClient, master_key_header: dict[str, str], month: str
) -> None:
    response = client.get(_ENDPOINT, params={"month": month}, headers=master_key_header)

    assert response.status_code == 422
