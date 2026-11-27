"""The caller's own organization's usage, for a tenant who does not operate the deployment.

``/api/v1/usage`` has been operator-only since #821, which
was right: it read every tenant's rows and its ``workspace_id`` parameter is a
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
* **``workspace_id`` still narrows, and cannot widen.** It is put through
  ``resolve_workspace_in_organization``, the same resolver every other
  workspace-scoped read uses, so a workspace outside the caller's scope answers
  404 exactly as a workspace that does not exist does.

Reads only. Deleting rows and repricing them stay operator-only, as does
``/api/v1/usage/in-flight``: its registry entries carry no workspace at all
(see ``usage.list_in_flight``), so there is nothing there to scope yet.

Every aggregation is the usage service's, the one ``usage.py`` calls too. This
module contributes route declarations, and nothing that could compute a different
answer to the same question.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from gateway.api.deps import CurrentIdentity, UsageServiceDep, WorkspaceAccessDep, verify_master_key
from gateway.api.routes._disconnect import CancelOnDisconnectRoute
from gateway.api.routes._usage_refinements import UsageRefinementsQuery
from gateway.api.routes.usage import (
    _API_KEY_MULTI_DESC,
    _COUNT_SORT_DESC,
    _COUNTS_DESC,
    _DIMENSIONS_DESC,
    _END_DESC,
    _ENDPOINT_DESC,
    _GROUP_BY_DESC,
    _GROUP_SEARCH_DESC,
    _INCLUDE_P95_DESC,
    _LOG_GROUP_BY_DESC,
    _LOG_GROUP_ORDER_DESC,
    _MAX_GROUP_SEARCH,
    _MAX_REQUEST_GROUPS,
    _MODEL_MULTI_DESC,
    _ORDER_DESC,
    _P95_BY_DESC,
    _PAID_DESC,
    _PRICED_DESC,
    _PROVIDER_DESC,
    _RANK_BY_DESC,
    _RANK_ORDER_DESC,
    _REQUEST_GROUP_DESC,
    _SORT_DESC,
    _SOURCE_DESC,
    _SOURCE_LABEL_DESC,
    _START_DESC,
    _STATUS_CODE_DESC,
    _STATUS_DESC,
    _TOOL_DESC,
    _USER_MULTI_DESC,
    _WORKSPACE_DESC,
    GroupByTag,
    TagFilter,
)
from gateway.core.sql import MAX_FILTER_VALUES
from gateway.core.surface import Surface
from gateway.schemas.usage_and_telemetry import (
    BreakdownDimension,
    BreakdownRankBy,
    Bucket,
    LogGroupBy,
    LogGroupOrder,
    SeriesGroupBy,
    SortOrder,
    SummaryDimension,
    ToolFilter,
    UsageCount,
    UsageEntry,
    UsageGroupedSeries,
    UsageLogGroups,
    UsageSort,
    UsageSummary,
    UsageValueGroups,
    ValueGroupBy,
)
from gateway.services.usage_and_telemetry import UsageFilters, UsageScope, parse_tag_filters

router = APIRouter(
    prefix="/organizations/me/usage",
    tags=["organization-usage"],
    # Authentication only, like the rest of the ``/api/v1/organizations/me`` surface.
    # What the caller may read is decided per request by ``readable_workspaces``, which
    # is the pattern the tenant-scoped routers already follow and the reason the
    # deployment operator gate does not belong here.
    dependencies=[Depends(verify_master_key)],
    route_class=CancelOnDisconnectRoute,
)

# Beside ``usage``, which reads one workspace at a time, because a deployment can serve several organizations.
SURFACE = Surface("organization_usage")


@router.get("")
async def list_organization_usage(
    identity: CurrentIdentity,
    access: WorkspaceAccessDep,
    usage: UsageServiceDep,
    refine: UsageRefinementsQuery,
    start_date: datetime | None = Query(default=None, description=_START_DESC),
    end_date: datetime | None = Query(default=None, description=_END_DESC),
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_USER_MULTI_DESC)] = None,
    status: str | None = Query(default=None, description=_STATUS_DESC),
    status_code: int | None = Query(default=None, description=_STATUS_CODE_DESC),
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_MODEL_MULTI_DESC)] = None,
    endpoint: str | None = Query(default=None, description=_ENDPOINT_DESC),
    provider: str | None = Query(default=None, description=_PROVIDER_DESC),
    source: str | None = Query(default=None, description=_SOURCE_DESC),
    source_label: str | None = Query(default=None, description=_SOURCE_LABEL_DESC),
    tag: TagFilter = None,
    api_key_id: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_API_KEY_MULTI_DESC)
    ] = None,
    priced: bool | None = Query(default=None, description=_PRICED_DESC),
    tool: ToolFilter | None = Query(default=None, description=_TOOL_DESC),
    counts_toward_budget: bool | None = Query(default=None, description=_COUNTS_DESC),
    deployment_paid: bool | None = Query(default=None, description=_PAID_DESC),
    request_group_id: Annotated[
        list[str] | None, Query(max_length=_MAX_REQUEST_GROUPS, description=_REQUEST_GROUP_DESC)
    ] = None,
    workspace_id: Annotated[uuid.UUID | None, Query(description=_WORKSPACE_DESC)] = None,
    sort: Annotated[UsageSort, Query(description=_SORT_DESC)] = "timestamp",
    order: Annotated[SortOrder, Query(description=_ORDER_DESC)] = "desc",
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> list[UsageEntry]:
    """List the caller's organization's usage logs, most recent first unless ``sort`` and ``order`` say otherwise.

    The tenant-scoped counterpart of ``GET /api/v1/usage``: same filters, same bare
    JSON array, same separate ``/count`` for a paginator's total, confined to
    what the caller's membership lets them see. Scope is never a parameter here.
    """
    scope = UsageScope(workspaces=await access.readable_workspaces(user=identity, workspace_id=workspace_id))
    filters = UsageFilters(
        start_date=start_date,
        end_date=end_date,
        user_id=user_id,
        status=status,
        status_code=status_code,
        model=model,
        endpoint=endpoint,
        provider=provider,
        source=source,
        source_label=source_label,
        tags=parse_tag_filters(tag),
        api_key_id=api_key_id,
        priced=priced,
        tool=tool,
        counts_toward_budget=counts_toward_budget,
        deployment_paid=deployment_paid,
        request_group_id=request_group_id,
        workspace_id=workspace_id,
        refine=refine,
    )
    return await usage.page(filters, scope, skip=skip, limit=limit, sort=sort, order=order)


@router.get("/count")
async def count_organization_usage(
    identity: CurrentIdentity,
    access: WorkspaceAccessDep,
    usage: UsageServiceDep,
    refine: UsageRefinementsQuery,
    start_date: datetime | None = Query(default=None, description=_START_DESC),
    end_date: datetime | None = Query(default=None, description=_END_DESC),
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_USER_MULTI_DESC)] = None,
    status: str | None = Query(default=None, description=_STATUS_DESC),
    status_code: int | None = Query(default=None, description=_STATUS_CODE_DESC),
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_MODEL_MULTI_DESC)] = None,
    endpoint: str | None = Query(default=None, description=_ENDPOINT_DESC),
    provider: str | None = Query(default=None, description=_PROVIDER_DESC),
    source: str | None = Query(default=None, description=_SOURCE_DESC),
    source_label: str | None = Query(default=None, description=_SOURCE_LABEL_DESC),
    tag: TagFilter = None,
    api_key_id: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_API_KEY_MULTI_DESC)
    ] = None,
    priced: bool | None = Query(default=None, description=_PRICED_DESC),
    tool: ToolFilter | None = Query(default=None, description=_TOOL_DESC),
    counts_toward_budget: bool | None = Query(default=None, description=_COUNTS_DESC),
    deployment_paid: bool | None = Query(default=None, description=_PAID_DESC),
    request_group_id: Annotated[
        list[str] | None, Query(max_length=_MAX_REQUEST_GROUPS, description=_REQUEST_GROUP_DESC)
    ] = None,
    workspace_id: Annotated[uuid.UUID | None, Query(description=_WORKSPACE_DESC)] = None,
    sort: Annotated[UsageSort, Query(description=_COUNT_SORT_DESC)] = "timestamp",
) -> UsageCount:
    """Total rows matching these filters, within the caller's scope.

    Serves the paginator's "N of M" beside the list above, and is scoped the
    same way, so the total can never describe more rows than the list will show.

    Unlike the operator's ``GET /api/v1/usage/count``, ``counts_toward_budget=false``
    is not narrowed to imported rows here: that narrowing sizes the bulk mutations, and
    this surface has none. So this total keeps matching the list beside it.
    """
    scope = UsageScope(workspaces=await access.readable_workspaces(user=identity, workspace_id=workspace_id))
    filters = UsageFilters(
        start_date=start_date,
        end_date=end_date,
        user_id=user_id,
        status=status,
        status_code=status_code,
        model=model,
        endpoint=endpoint,
        provider=provider,
        source=source,
        source_label=source_label,
        tags=parse_tag_filters(tag),
        api_key_id=api_key_id,
        priced=priced,
        tool=tool,
        counts_toward_budget=counts_toward_budget,
        deployment_paid=deployment_paid,
        request_group_id=request_group_id,
        workspace_id=workspace_id,
        refine=refine,
    )
    return UsageCount(total=await usage.count(filters, scope, sort=sort))


@router.get("/summary")
async def organization_usage_summary(
    identity: CurrentIdentity,
    access: WorkspaceAccessDep,
    usage: UsageServiceDep,
    refine: UsageRefinementsQuery,
    start_date: datetime | None = Query(default=None, description=_START_DESC),
    end_date: datetime | None = Query(default=None, description=_END_DESC),
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_USER_MULTI_DESC)] = None,
    status: str | None = Query(default=None, description=_STATUS_DESC),
    status_code: int | None = Query(default=None, description=_STATUS_CODE_DESC),
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_MODEL_MULTI_DESC)] = None,
    endpoint: str | None = Query(default=None, description=_ENDPOINT_DESC),
    provider: str | None = Query(default=None, description=_PROVIDER_DESC),
    source: str | None = Query(default=None, description=_SOURCE_DESC),
    source_label: str | None = Query(default=None, description=_SOURCE_LABEL_DESC),
    tag: TagFilter = None,
    api_key_id: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_API_KEY_MULTI_DESC)
    ] = None,
    priced: bool | None = Query(default=None, description=_PRICED_DESC),
    tool: ToolFilter | None = Query(default=None, description=_TOOL_DESC),
    counts_toward_budget: bool | None = Query(default=None, description=_COUNTS_DESC),
    deployment_paid: bool | None = Query(default=None, description=_PAID_DESC),
    workspace_id: Annotated[uuid.UUID | None, Query(description=_WORKSPACE_DESC)] = None,
    bucket: Bucket = Query(default="day", description="Time-series granularity: 'hour' or 'day'"),
    dimensions: list[SummaryDimension] | None = Query(default=None, description=_DIMENSIONS_DESC),
    group_by_tag: GroupByTag = None,
    include_p95: Annotated[bool, Query(description=_INCLUDE_P95_DESC)] = False,
    p95_by: Annotated[BreakdownDimension | None, Query(description=_P95_BY_DESC)] = None,
    rank_by: Annotated[BreakdownRankBy, Query(description=_RANK_BY_DESC)] = "cost",
    rank_order: Annotated[SortOrder, Query(description=_RANK_ORDER_DESC)] = "desc",
) -> UsageSummary:
    """Aggregate spend, tokens and request volume for the caller's organization.

    The tenant-scoped counterpart of ``GET /api/v1/usage/summary``, running the same
    aggregation over a narrower row set: the same bounded window, the same
    breakdowns, the same ``dimensions`` selector for paying only for the passes a
    caller reads. The breakdown by user names the people inside the caller's own
    scope, which is the roster they can already read.
    """
    scope = UsageScope(workspaces=await access.readable_workspaces(user=identity, workspace_id=workspace_id))
    filters = UsageFilters(
        start_date=start_date,
        end_date=end_date,
        user_id=user_id,
        status=status,
        status_code=status_code,
        model=model,
        endpoint=endpoint,
        provider=provider,
        source=source,
        source_label=source_label,
        tags=parse_tag_filters(tag),
        api_key_id=api_key_id,
        priced=priced,
        tool=tool,
        counts_toward_budget=counts_toward_budget,
        deployment_paid=deployment_paid,
        workspace_id=workspace_id,
        refine=refine,
    )
    return await usage.summary(
        filters,
        scope,
        bucket=bucket,
        dimensions=dimensions,
        group_by_tag=group_by_tag,
        include_p95=include_p95,
        p95_by=p95_by,
        rank_by=rank_by,
        rank_order=rank_order,
    )


@router.get("/series")
async def organization_usage_series(
    identity: CurrentIdentity,
    access: WorkspaceAccessDep,
    usage: UsageServiceDep,
    refine: UsageRefinementsQuery,
    group_by: SeriesGroupBy = Query(description="Dimension to split the series by"),
    start_date: datetime | None = Query(default=None, description=_START_DESC),
    end_date: datetime | None = Query(default=None, description=_END_DESC),
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_USER_MULTI_DESC)] = None,
    status: str | None = Query(default=None, description=_STATUS_DESC),
    status_code: int | None = Query(default=None, description=_STATUS_CODE_DESC),
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_MODEL_MULTI_DESC)] = None,
    endpoint: str | None = Query(default=None, description=_ENDPOINT_DESC),
    provider: str | None = Query(default=None, description=_PROVIDER_DESC),
    source: str | None = Query(default=None, description=_SOURCE_DESC),
    source_label: str | None = Query(default=None, description=_SOURCE_LABEL_DESC),
    tag: TagFilter = None,
    api_key_id: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_API_KEY_MULTI_DESC)
    ] = None,
    priced: bool | None = Query(default=None, description=_PRICED_DESC),
    tool: ToolFilter | None = Query(default=None, description=_TOOL_DESC),
    counts_toward_budget: bool | None = Query(default=None, description=_COUNTS_DESC),
    deployment_paid: bool | None = Query(default=None, description=_PAID_DESC),
    workspace_id: Annotated[uuid.UUID | None, Query(description=_WORKSPACE_DESC)] = None,
    bucket: Bucket = Query(default="day", description="Time-series granularity: 'hour' or 'day'"),
) -> UsageGroupedSeries:
    """Time series split by one dimension, for the caller's organization.

    The tenant-scoped counterpart of ``GET /api/v1/usage/series``, and kept in
    lockstep with the summary above for the reason that endpoint gives: the
    dashboard serializes one filter object for both, so a filter one of them
    ignored would make the stacked chart disagree with the tiles beside it.
    """
    scope = UsageScope(workspaces=await access.readable_workspaces(user=identity, workspace_id=workspace_id))
    filters = UsageFilters(
        start_date=start_date,
        end_date=end_date,
        user_id=user_id,
        status=status,
        status_code=status_code,
        model=model,
        endpoint=endpoint,
        provider=provider,
        source=source,
        source_label=source_label,
        tags=parse_tag_filters(tag),
        api_key_id=api_key_id,
        priced=priced,
        tool=tool,
        counts_toward_budget=counts_toward_budget,
        deployment_paid=deployment_paid,
        workspace_id=workspace_id,
        refine=refine,
    )
    return await usage.grouped_series(filters, scope, bucket=bucket, group_by=group_by)


@router.get("/groups")
async def organization_usage_value_groups(
    identity: CurrentIdentity,
    access: WorkspaceAccessDep,
    usage: UsageServiceDep,
    refine: UsageRefinementsQuery,
    group_by: ValueGroupBy = Query(description=_GROUP_BY_DESC),
    start_date: datetime | None = Query(default=None, description=_START_DESC),
    end_date: datetime | None = Query(default=None, description=_END_DESC),
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_USER_MULTI_DESC)] = None,
    status: str | None = Query(default=None, description=_STATUS_DESC),
    status_code: int | None = Query(default=None, description=_STATUS_CODE_DESC),
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_MODEL_MULTI_DESC)] = None,
    endpoint: str | None = Query(default=None, description=_ENDPOINT_DESC),
    provider: str | None = Query(default=None, description=_PROVIDER_DESC),
    source: str | None = Query(default=None, description=_SOURCE_DESC),
    source_label: str | None = Query(default=None, description=_SOURCE_LABEL_DESC),
    tag: TagFilter = None,
    api_key_id: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_API_KEY_MULTI_DESC)
    ] = None,
    priced: bool | None = Query(default=None, description=_PRICED_DESC),
    tool: ToolFilter | None = Query(default=None, description=_TOOL_DESC),
    counts_toward_budget: bool | None = Query(default=None, description=_COUNTS_DESC),
    workspace_id: Annotated[uuid.UUID | None, Query(description=_WORKSPACE_DESC)] = None,
    search: Annotated[str | None, Query(max_length=_MAX_GROUP_SEARCH, description=_GROUP_SEARCH_DESC)] = None,
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> UsageValueGroups:
    """One column's values over the window, for the caller's organization.

    The tenant-scoped counterpart of ``GET /api/v1/usage/groups``: the same
    values, over the rows this caller may read.
    """
    scope = UsageScope(workspaces=await access.readable_workspaces(user=identity, workspace_id=workspace_id))
    filters = UsageFilters(
        start_date=start_date,
        end_date=end_date,
        user_id=user_id,
        status=status,
        status_code=status_code,
        model=model,
        endpoint=endpoint,
        provider=provider,
        source=source,
        source_label=source_label,
        tags=parse_tag_filters(tag),
        api_key_id=api_key_id,
        priced=priced,
        tool=tool,
        counts_toward_budget=counts_toward_budget,
        workspace_id=workspace_id,
        refine=refine,
    )
    return await usage.value_groups(filters, scope, group_by=group_by, search=search, skip=skip, limit=limit)


@router.get("/grouped")
async def organization_usage_log_groups(
    identity: CurrentIdentity,
    access: WorkspaceAccessDep,
    usage: UsageServiceDep,
    refine: UsageRefinementsQuery,
    group_by: LogGroupBy = Query(description=_LOG_GROUP_BY_DESC),
    start_date: datetime | None = Query(default=None, description=_START_DESC),
    end_date: datetime | None = Query(default=None, description=_END_DESC),
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_USER_MULTI_DESC)] = None,
    status: str | None = Query(default=None, description=_STATUS_DESC),
    status_code: int | None = Query(default=None, description=_STATUS_CODE_DESC),
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_MODEL_MULTI_DESC)] = None,
    endpoint: str | None = Query(default=None, description=_ENDPOINT_DESC),
    provider: str | None = Query(default=None, description=_PROVIDER_DESC),
    source: str | None = Query(default=None, description=_SOURCE_DESC),
    source_label: str | None = Query(default=None, description=_SOURCE_LABEL_DESC),
    tag: TagFilter = None,
    api_key_id: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=_API_KEY_MULTI_DESC)
    ] = None,
    priced: bool | None = Query(default=None, description=_PRICED_DESC),
    tool: ToolFilter | None = Query(default=None, description=_TOOL_DESC),
    counts_toward_budget: bool | None = Query(default=None, description=_COUNTS_DESC),
    workspace_id: Annotated[uuid.UUID | None, Query(description=_WORKSPACE_DESC)] = None,
    order: LogGroupOrder = Query(default="recent", description=_LOG_GROUP_ORDER_DESC),
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> UsageLogGroups:
    """The request log grouped by one column, for the caller's organization.

    The tenant-scoped counterpart of ``GET /api/v1/usage/grouped``: the same
    groups, over the rows this caller may read.
    """
    scope = UsageScope(workspaces=await access.readable_workspaces(user=identity, workspace_id=workspace_id))
    filters = UsageFilters(
        start_date=start_date,
        end_date=end_date,
        user_id=user_id,
        status=status,
        status_code=status_code,
        model=model,
        endpoint=endpoint,
        provider=provider,
        source=source,
        source_label=source_label,
        tags=parse_tag_filters(tag),
        api_key_id=api_key_id,
        priced=priced,
        tool=tool,
        counts_toward_budget=counts_toward_budget,
        workspace_id=workspace_id,
        refine=refine,
    )
    return await usage.log_groups(filters, scope, group_by=group_by, order=order, skip=skip, limit=limit)
