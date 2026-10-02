"""The caller's own organization's usage, for a tenant who does not operate the deployment.

``/api/v1/usage`` is deployment-wide and has been operator-only since #821, which
was right: it reads every tenant's rows and its ``workspace_id`` parameter is a
filter the client supplies, so nothing but the operator gate stands between a
signed-in member and another organization's traffic. On a deployment serving
mutually-untrusting tenants that left "show me my organization's usage", the
ordinary case, with no endpoint a member is allowed to call at all
(mozilla-ai/otari#837).

The answer is not a looser gate on that router. A mode that widened
``/api/v1/usage`` for a non-operator would inherit its client-supplied
``workspace_id`` and rebuild the escalation #821 closed. So the deployment-wide
routes keep the gate they have, unchanged, and this router is a second, narrower
reading of the same rows:

* **Scope is derived, never accepted.** It comes from the caller's own
  ``active_organization_id`` by way of ``resolve_visible_workspace_scope``,
  which refuses a pointer with no live membership behind it. No request here
  names an organization. Moving between organizations is
  ``POST /api/v1/organizations/me/switch``, which 404s on one the caller does not
  belong to.
* **How much of the organization** follows the rule the workspace list already
  uses: an owner or an admin reads every workspace in it, and a
  member or viewer reads the ones they actively belong to. A member who belongs
  to no workspace gets an empty page, not a refusal: the surface is theirs and
  simply has nothing in it yet.
* **Whose requests** follows the workspace management rule
  (``has_workspace_management_access``): in a workspace the caller manages, as
  an owner or admin of the organization or of that workspace, they read
  everyone's rows, and anywhere else only the rows billed to them
  (``users.user_id`` is their identity's id, the row their own keys bill
  through), even in a workspace they share with other people. Managing one
  workspace widens that workspace and no other, so a workspace admin reading
  across the organization sees the rest of it as a member does. A superuser
  reads everyone's rows in a workspace they name.
* **``workspace_id`` still narrows, and cannot widen.** It is put through
  ``resolve_workspace_in_organization``, the same resolver every other
  workspace-scoped read uses, so a workspace outside the caller's scope answers
  404 exactly as a workspace that does not exist does.

Reads only. Deleting rows and repricing them stay deployment-wide, as does
``/api/v1/usage/in-flight``: its registry entries carry no workspace at all
(see ``usage.list_in_flight``), so there is nothing there to scope yet.

Every aggregation is the one ``usage.py`` already runs. This module contributes
route declarations and a scope predicate, and nothing that could compute a
different answer to the same question.
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import ColumnElement, and_, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from gateway.api.deps import CurrentIdentity, UsageReadServiceDep, get_db, verify_master_key
from gateway.api.routes._usage_common import (
    COUNT_SORT_DESC,
    DIMENSIONS_DESC,
    GROUP_BY_DESC,
    GROUP_ORDER_DESC,
    GROUP_SEARCH_DESC,
    INCLUDE_P95_DESC,
    ORDER_DESC,
    SORT_DESC,
    SUMMARY_BUCKET_DESC,
    UsageListFilters,
    UsageReadFilters,
)
from gateway.api.routes.usage import (
    Bucket,
    SeriesGroupBy,
    SummaryDimension,
    UsageCount,
    UsageEntry,
    UsageGroupedSeries,
    UsageSummary,
    _activity_groups_response,
    _grouped_series_response,
    _list_usage_entries,
    _summary_context,
    _summary_response,
)
from gateway.core.sql import UsageBucketGrain
from gateway.core.surface import Surface
from gateway.core.usage_filters import MAX_SEARCH_LENGTH, SortOrder, UsageSort, list_window, resolve_window
from gateway.models.tenancy import User as TenancyUser
from gateway.models.tenancy import Workspace
from gateway.models.usage import UsageLog
from gateway.schemas.usage import ActivityGroupBy, ActivityGroupOrder, UsageActivityGroups
from gateway.services.tenancy import OrganizationService
from gateway.services.tenancy.authorization import (
    has_workspace_management_access,
    resolve_managed_workspace_ids,
    resolve_visible_workspace_scope,
    resolve_workspace_in_organization,
)

router = APIRouter(
    prefix="/organizations/me/usage",
    tags=["organization-usage"],
    # Authentication only, like the rest of the ``/api/v1/organizations/me`` surface.
    # What the caller may read is decided per request by the scope below, which
    # is the pattern the tenant-scoped routers already follow and the reason the
    # deployment operator gate does not belong here.
    dependencies=[Depends(verify_master_key)],
)

# Hosted only: on standalone the organization is the deployment, so ``usage`` already shows it.
SURFACE = Surface("organization_usage", standalone=False)


def _own_requests(user: TenancyUser) -> ColumnElement[bool]:
    """The rows billed to this identity's attribution user, which is keyed on its id."""
    return col(UsageLog.user_id) == str(user.id)


async def _scope_condition(
    db: AsyncSession,
    *,
    user: TenancyUser,
    workspace_id: uuid.UUID | None,
) -> ColumnElement[bool]:
    """The WHERE clause that confines a read to what this caller may see.

    Resolved per request rather than cached on the session: a membership can be
    suspended or a role changed between two requests, and the cheaper answer is
    the one that goes stale in the unsafe direction.
    """
    organizations = OrganizationService(db, membership_listener=None)

    if workspace_id is not None:
        # Only the organization is resolved on this branch. The full scope would
        # also build the caller's workspace-id set, which is deliberately
        # unpaged, and the branch below discards it: the Activity page issues a
        # list, a count, a summary and a series per filter change, so resolving
        # it here would be four unbounded reads an interaction, for nothing.
        # ``get_active_organization_for_user`` is the same refusal the full scope
        # opens with, so a pointer with no live membership behind it still stops
        # here rather than reaching the resolver below.
        organization = await organizations.get_active_organization_for_user(user)
        # Narrowing only. The resolver raises ``WorkspaceNotFoundError`` (404) for
        # a workspace in another organization *and* for one in this organization
        # the caller is not a member of, which is what keeps the parameter from
        # being an existence oracle either way.
        #
        # The equality returned below duplicates the one ``UsageReadFilters.conditions`` builds
        # from the same parameter, and that is deliberate: the scope has to be
        # sufficient on its own, so a later change to how the filter is applied
        # cannot leave a request scoped by nothing.
        workspace = await resolve_workspace_in_organization(
            db,
            user=user,
            workspace_id=workspace_id,
            organization=organization,
            organizations=organizations,
        )
        workspace_rows = col(UsageLog.workspace_id) == workspace_id
        if user.is_superuser or await has_workspace_management_access(
            db, user=user, workspace=workspace, organizations=organizations
        ):
            return workspace_rows
        return and_(workspace_rows, _own_requests(user))

    scope = await resolve_visible_workspace_scope(db, user=user, organizations=organizations)
    if scope.sees_every_workspace:
        return col(UsageLog.workspace_id).in_(
            select(col(Workspace.id)).where(col(Workspace.organization_id) == scope.organization.id)
        )
    if not scope.workspace_ids:
        # Belongs to no workspace yet. An empty result, and deliberately not a
        # 403: nothing was refused, there is simply nothing here.
        return false()
    # Not the management arm above, so a member of the organization: everyone's
    # requests in the workspaces they manage, and their own in the rest of theirs.
    visible = col(UsageLog.workspace_id).in_(scope.workspace_ids)
    managed = await resolve_managed_workspace_ids(db, user=user, scope=scope)
    if not managed:
        return and_(visible, _own_requests(user))
    return and_(visible, or_(col(UsageLog.workspace_id).in_(managed), _own_requests(user)))


@router.get("")
async def list_organization_usage(
    identity: CurrentIdentity,
    db: Annotated[AsyncSession, Depends(get_db)],
    reads: UsageReadServiceDep,
    filters: Annotated[UsageListFilters, Depends()],
    sort: Annotated[UsageSort, Query(description=SORT_DESC)] = "timestamp",
    order: Annotated[SortOrder, Query(description=ORDER_DESC)] = "desc",
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> list[UsageEntry]:
    """List the caller's organization's usage logs, newest first unless ``sort``/``order`` say otherwise.

    The tenant-scoped counterpart of ``GET /api/v1/usage``: same filters, same bare
    JSON array, same separate ``/count`` for a paginator's total, confined to
    what the caller's membership lets them see. Scope is never a parameter here.
    """
    scope = await _scope_condition(db, user=identity, workspace_id=filters.workspace_id)
    start_date, end_date = list_window(filters.start_date, filters.end_date, q=filters.q, sort=sort)
    conditions = filters.conditions(start_date=start_date, end_date=end_date, scope=scope)
    return await _list_usage_entries(reads, conditions, scope=scope, skip=skip, limit=limit, sort=sort, order=order)


@router.get("/count")
async def count_organization_usage(
    identity: CurrentIdentity,
    db: Annotated[AsyncSession, Depends(get_db)],
    filters: Annotated[UsageListFilters, Depends()],
    sort: Annotated[UsageSort, Query(description=COUNT_SORT_DESC)] = "timestamp",
) -> UsageCount:
    """Total rows matching these filters, within the caller's scope.

    Serves the paginator's "N of M" beside the list above, and is scoped the
    same way, so the total can never describe more rows than the list will show.

    Unlike the deployment-wide ``GET /api/v1/usage/count``, ``counts_toward_budget=false``
    is not narrowed to imported rows here: that narrowing sizes the bulk mutations, and
    this surface has none. So this total keeps matching the list beside it.
    """
    start_date, end_date = list_window(filters.start_date, filters.end_date, q=filters.q, sort=sort)
    scope = await _scope_condition(db, user=identity, workspace_id=filters.workspace_id)
    conditions = filters.conditions(start_date=start_date, end_date=end_date, scope=scope)
    stmt: Any = select(func.count()).select_from(UsageLog).where(*conditions)
    return UsageCount(total=(await db.execute(stmt)).scalar_one())


@router.get("/summary")
async def organization_usage_summary(
    identity: CurrentIdentity,
    db: Annotated[AsyncSession, Depends(get_db)],
    reads: UsageReadServiceDep,
    filters: Annotated[UsageReadFilters, Depends()],
    bucket: UsageBucketGrain = Query(default="day", description=SUMMARY_BUCKET_DESC),
    dimensions: list[SummaryDimension] | None = Query(default=None, description=DIMENSIONS_DESC),
    include_p95: Annotated[bool, Query(description=INCLUDE_P95_DESC)] = False,
) -> UsageSummary:
    """Aggregate spend, tokens and request volume for the caller's organization.

    The tenant-scoped counterpart of ``GET /api/v1/usage/summary``, running the same
    aggregation over a narrower row set: the same bounded window, the same
    breakdowns, the same ``dimensions`` selector for paying only for the passes a
    caller reads. The breakdown by user names the people inside the caller's own
    scope, which is the roster they can already read.
    """
    scope = await _scope_condition(db, user=identity, workspace_id=filters.workspace_id)
    start, end, conditions, totals = await _summary_context(
        db, filters, grid=bucket if bucket == "5min" else None, scope=scope
    )
    return await _summary_response(
        db,
        reads,
        start=start,
        end=end,
        conditions=conditions,
        totals=totals,
        status=filters.status,
        bucket=bucket,
        dimensions=dimensions,
        include_p95=include_p95,
    )


@router.get("/series")
async def organization_usage_series(
    identity: CurrentIdentity,
    db: Annotated[AsyncSession, Depends(get_db)],
    filters: Annotated[UsageReadFilters, Depends()],
    group_by: SeriesGroupBy = Query(description="Dimension to split the series by"),
    bucket: Bucket = Query(default="day", description="Time-series granularity: 'hour' or 'day'"),
) -> UsageGroupedSeries:
    """Time series split by one dimension, for the caller's organization.

    The tenant-scoped counterpart of ``GET /api/v1/usage/series``, and kept in
    lockstep with the summary above for the reason that endpoint gives: the
    dashboard serializes one filter object for both, so a filter one of them
    ignored would make the stacked chart disagree with the tiles beside it.
    """
    scope = await _scope_condition(db, user=identity, workspace_id=filters.workspace_id)
    start, end, conditions, totals = await _summary_context(db, filters, grid=bucket, scope=scope)
    return await _grouped_series_response(
        db,
        start=start,
        end=end,
        conditions=conditions,
        totals=totals,
        status=filters.status,
        bucket=bucket,
        group_by=group_by,
    )


@router.get("/groups")
async def organization_usage_activity_groups(
    identity: CurrentIdentity,
    db: Annotated[AsyncSession, Depends(get_db)],
    reads: UsageReadServiceDep,
    filters: Annotated[UsageReadFilters, Depends()],
    group_by: ActivityGroupBy = Query(description=GROUP_BY_DESC),
    search: Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH, description=GROUP_SEARCH_DESC)] = None,
    order: Annotated[ActivityGroupOrder, Query(description=GROUP_ORDER_DESC)] = "recent",
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> UsageActivityGroups:
    """The caller's organization's activity log, one row per API key, session, model, user, policy or alias.

    The tenant-scoped counterpart of ``GET /api/v1/usage/groups``: the same
    aggregation over the rows this caller may read.
    """
    start, end = resolve_window(filters.start_date, filters.end_date)
    scope = await _scope_condition(db, user=identity, workspace_id=filters.workspace_id)
    conditions = filters.conditions(start_date=start, end_date=end, scope=scope)
    return await _activity_groups_response(
        reads,
        group_by=group_by,
        start=start,
        end=end,
        conditions=conditions,
        status=filters.status,
        search=search,
        order=order,
        skip=skip,
        limit=limit,
    )
