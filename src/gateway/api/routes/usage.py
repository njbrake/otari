"""Bulk usage log endpoint.

Provides a single query interface over all usage logs with optional
time range and user filters, ordered newest-first. Intended for
external systems that need to sync usage data (billing, analytics).
"""

from collections.abc import Sequence
from datetime import datetime
from time import monotonic
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gateway.api.deps import (
    UsageReadServiceDep,
    get_config,
    get_db,
    require_deployment_operator,
    verify_api_key_or_master_key,
)
from gateway.api.routes._billing_schemas import ChargeLine, MeterMap
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
    UsageCountFilters,
    UsageListFilters,
    UsageReadFilters,
    summary_window,
)
from gateway.core.config import GatewayConfig
from gateway.core.database import get_ingest_db
from gateway.core.sql import UsageBucketGrain, utc_bound
from gateway.core.surface import Surface
from gateway.core.usage_filters import (
    MAX_SEARCH_LENGTH,
    SortOrder,
    UsageSort,
    list_window,
    resolve_window,
)
from gateway.core.usage_source import is_served_here, not_served_here
from gateway.inflight import get_registry
from gateway.models.api_keys import APIKey
from gateway.models.money import as_float
from gateway.models.usage import UsageLog
from gateway.schemas.usage import (
    ActivityGroupBy,
    ActivityGroupOrder,
    Bucket,
    SeriesGroupBy,
    SummaryDimension,
    UsageActivityGroups,
    UsageGroupedSeries,
    UsageSummary,
)
from gateway.services.external_usage_service import (
    ExternalEventsRequest,
    ExternalIngestResult,
    ingest_external_events,
)
from gateway.services.usage import UsagePageRow
from gateway.services.usage_admin_service import (
    UsageDeleteRequest,
    UsageDeleteResult,
    UsageSetPriceRequest,
    UsageSetPriceResult,
    delete_usage,
    set_usage_price,
)

# Two routers under one prefix, because the two planes that meet here
# authenticate differently. Reading or amending every tenant's usage rows is
# deployment-wide, so that gate is declared on the router and a route added later
# inherits it; ``POST /external-events`` files rows on behalf of the API key that
# holds them, and is split onto a router of its own rather than left as a
# route-level override so that admitting a non-operator is spelled here. Each
# router names its own rule, so adding a route to either one inherits a gate
# rather than none.
operator_router = APIRouter(
    prefix="/usage",
    tags=["usage"],
    dependencies=[Depends(require_deployment_operator)],
)
ingest_router = APIRouter(
    prefix="/usage",
    tags=["usage"],
    dependencies=[Depends(verify_api_key_or_master_key)],
)

SURFACE = Surface("usage")

# How many in-flight requests are serialized. A live panel is read at a glance, so
# a fixed cap beats a pagination knob; the response reports the true count next to
# the capped list, and the longest-running are the ones kept.
_MAX_IN_FLIGHT_ROWS = 50


def _utc_iso(value: datetime) -> str:
    """Serialize a stored timestamp as unambiguous UTC ISO-8601.

    ``usage_logs.timestamp`` is timezone-aware, but SQLite returns it naive (it does
    not persist the offset). A naive ``isoformat()`` has no ``+00:00``, so a browser
    reads it in its own local zone and a recent UTC event can land in the future,
    showing as "0s ago". Treat a naive value as the UTC it was stored as.
    """
    return utc_bound(value).isoformat()


class UsageEntry(BaseModel):
    """A single usage log entry."""

    id: str
    user_id: str | None
    # Display labels resolved server-side, so a client rendering a page of rows
    # does not have to hold the whole users/api_keys tables to name them. Null
    # when the row has no owner, when the referenced row is gone (both foreign
    # keys are ON DELETE SET NULL), or when the entity simply has no label set;
    # a client falls back to the id in every one of those cases.
    user_alias: str | None = None
    api_key_id: str | None
    api_key_name: str | None = None
    timestamp: str
    model: str
    provider: str | None
    endpoint: str
    prompt_tokens: int | None
    completion_tokens: int | None
    total_tokens: int | None
    cache_read_tokens: int | None
    cache_write_tokens: int | None
    cache_write_1h_tokens: int | None
    # Precise shapes with a permissive fallback arm; see _billing_schemas for why
    # the fallback is what keeps a row written by an older gateway renderable.
    billing_meters: MeterMap | None
    pricing_breakdown: Sequence[ChargeLine] | None
    cost: float | None
    status: str
    error_message: str | None
    status_code: int | None
    latency_ms: int | None
    source: str
    source_label: str | None
    counts_toward_budget: bool
    # Whether the bulk operator mutations can reach this row: the fixed scope
    # ``_selection_conditions`` pins them to, which is provenance *and* budget
    # participation. Derived here rather than left to the client, because a client
    # composing it from the two fields above is a second copy of the rule, and the
    # copy is what let the dashboard offer a checkbox the delete then refused (#781).
    bulk_editable: bool
    # Routing attribution. All null for a request that named a plain model.
    # `status == "absorbed"` marks an attempt a policy recovered from; those rows
    # are excluded from `error_count` and from `request_count`, since the request
    # they belong to is counted once by the attempt that served it.
    policy_name: str | None = None
    selection_reason: str | None = None
    attempt_position: int | None = None
    attempt_count: int | None = None
    request_group_id: str | None = None
    # The model name the caller sent, before an alias or a routing policy resolved
    # it to ``model``. Null on rows written before it was recorded, on imported
    # usage, and on side-calls no caller named.
    requested_model: str | None = None
    # Milliseconds from the start of the request to its first streamed chunk. Null
    # for a non-streaming request, a stream that failed before its first chunk, a
    # row written before it was recorded, and imported usage.
    ttft_ms: int | None = None
    # The request's ``Otari-Request-ID``; null where none was minted.
    request_id: str | None = None
    # How many earlier attempts of this row's routed request failed (rows of the
    # same ``request_group_id`` with status ``absorbed``), whether or not a later
    # attempt then served. Always 0 on an unrouted request and on an absorbed row.
    absorbed_attempts: int = 0

    @classmethod
    def from_page_row(cls, row: UsagePageRow) -> "UsageEntry":
        """An entry for one row of a page the read service returned, with its labels and folded attempts."""
        return cls.from_model(
            row.log,
            user_alias=row.user_alias,
            api_key_name=row.api_key_name,
            absorbed_attempts=row.absorbed_attempts,
        )

    @classmethod
    def from_model(
        cls,
        log: UsageLog,
        *,
        user_alias: str | None = None,
        api_key_name: str | None = None,
        absorbed_attempts: int = 0,
    ) -> "UsageEntry":
        return cls(
            id=log.id,
            user_id=log.user_id,
            user_alias=user_alias,
            api_key_id=log.api_key_id,
            api_key_name=api_key_name,
            timestamp=_utc_iso(log.timestamp),
            model=log.model,
            requested_model=log.requested_model,
            request_id=log.request_id,
            ttft_ms=log.ttft_ms,
            absorbed_attempts=absorbed_attempts,
            provider=log.provider,
            endpoint=log.endpoint,
            source=log.source,
            source_label=log.source_label,
            counts_toward_budget=log.counts_toward_budget,
            bulk_editable=not is_served_here(log.source) and not log.counts_toward_budget,
            prompt_tokens=log.prompt_tokens,
            completion_tokens=log.completion_tokens,
            total_tokens=log.total_tokens,
            cache_read_tokens=log.cache_read_tokens,
            cache_write_tokens=log.cache_write_tokens,
            cache_write_1h_tokens=log.cache_write_1h_tokens,
            billing_meters=log.billing_meters,
            pricing_breakdown=log.pricing_breakdown,
            cost=as_float(log.cost),
            status=log.status,
            error_message=log.error_message,
            status_code=log.status_code,
            latency_ms=log.latency_ms,
            policy_name=log.policy_name,
            selection_reason=log.selection_reason,
            attempt_position=log.attempt_position,
            attempt_count=log.attempt_count,
            request_group_id=log.request_group_id,
        )


class UsageCount(BaseModel):
    """Total number of usage logs matching a set of filters."""

    total: int


class InFlightEntry(BaseModel):
    """One request the gateway is serving right now.

    Field names match their ``UsageEntry`` counterparts so a request reads the
    same way in flight as it does once it has settled. ``id`` is the exception: it
    is an ephemeral tracking id, not the id of the usage row this will become.
    """

    id: str
    endpoint: str
    model: str
    provider: str | None
    user_id: str | None
    api_key_id: str | None
    policy_name: str | None
    started_at: datetime
    elapsed_ms: int


class InFlightResponse(BaseModel):
    """The requests in flight on the answering worker."""

    requests: list[InFlightEntry]
    total: int


@operator_router.get("")
async def list_usage(
    reads: UsageReadServiceDep,
    filters: Annotated[UsageListFilters, Depends()],
    sort: Annotated[UsageSort, Query(description=SORT_DESC)] = "timestamp",
    order: Annotated[SortOrder, Query(description=ORDER_DESC)] = "desc",
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> list[UsageEntry]:
    """List usage logs, newest first unless ``sort``/``order`` say otherwise.

    Supports optional filters for time range, user, status, failure status code,
    model, endpoint, provider, source, session (``source_label``), and request
    group (``request_group_id``, repeatable, which returns a routed request's
    whole attempt plan), row id (``id``), the model name the caller sent
    (``requested_model``), and free-text search (``q``). With
    ``include_absorbed=false`` each routed request is listed once, as the row that
    settled it, carrying ``absorbed_attempts``. Paginated via skip/limit. The
    return shape is a bare JSON array; external billing/analytics consumers
    depend on this, so the total row count for a
    paginated UI is served separately by ``GET /api/v1/usage/count`` rather than
    wrapped in an envelope here. Timestamps accept either ISO 8601 strings or
    Unix epoch seconds (numeric).
    """
    start_date, end_date = list_window(filters.start_date, filters.end_date, q=filters.q, sort=sort)
    conditions = filters.conditions(start_date=start_date, end_date=end_date, scope=None)
    rows = await reads.page(conditions, scope=None, sort=sort, order=order, skip=skip, limit=limit)
    return [UsageEntry.from_page_row(row) for row in rows]


@ingest_router.post("/external-events")
async def ingest_external_usage(
    request: ExternalEventsRequest,
    auth_result: Annotated[tuple[APIKey | None, bool], Depends(verify_api_key_or_master_key)],
    db: Annotated[AsyncSession, Depends(get_ingest_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
) -> ExternalIngestResult:
    """Ingest a batch of externally-observed usage events (standalone).

    Authenticated with either an API key or the master key. Usage binds to the
    authenticated principal: an API key attributes to its own user (and stamps its
    id on the rows); the master key may name any user via ``user_id``. Records
    subscription-backed usage (e.g. Claude Code) as usage-log rows tagged with their
    ``source``, priced at the effective API rate for each event's timestamp.
    Imported usage is real cost, but never counts toward budgets or mutates
    ``users.spend`` (it is retrospective, so it cannot be reserved). Idempotent by
    ``(source, source_event_id)``. The payload is content-free; any
    prompt/completion/tool field is rejected (422), not stored.
    """
    api_key, is_master_key = auth_result
    return await ingest_external_events(
        db,
        request,
        api_key=api_key,
        is_master_key=is_master_key,
        reject_user_mismatch=config.reject_user_mismatch,
    )


@operator_router.get("/count")
async def count_usage(
    db: Annotated[AsyncSession, Depends(get_db)],
    filters: Annotated[UsageCountFilters, Depends()],
    sort: Annotated[UsageSort, Query(description=COUNT_SORT_DESC)] = "timestamp",
) -> UsageCount:
    """Total number of usage logs matching the given filters.

    Serves the dashboard paginator's "N of M" total without changing the bare
    array contract of ``GET /api/v1/usage``. Runs only when the client asks (a
    separate request), so the ``COUNT(*)`` is not paid on every page load. With
    ``counts_toward_budget=false`` it also backs the "select all N matching this
    filter" affordance for bulk delete / set-price, which touch imported rows only.

    That value is the one place this count is narrower than ``GET /api/v1/usage``: it
    also excludes rows this deployment served itself, so the number an operator
    confirms is the number the mutation can reach. The list still pages the
    budget-exempt gateway rows it omits.
    """
    start_date, end_date = list_window(filters.start_date, filters.end_date, q=filters.q, sort=sort)
    conditions = filters.conditions(start_date=start_date, end_date=end_date, scope=None)
    if filters.counts_toward_budget is False:
        # counts_toward_budget alone does not say "imported": gateway traffic on an
        # exclude_from_budget key is also False, so without this the count would
        # promise rows _selection_conditions then refuses to touch.
        conditions.append(not_served_here(UsageLog.source))
    stmt: Any = select(func.count()).select_from(UsageLog).where(*conditions)
    total = (await db.execute(stmt)).scalar_one()
    return UsageCount(total=total)


@operator_router.get("/in-flight")
async def list_in_flight(raw_request: Request) -> InFlightResponse:
    """Requests the gateway is currently serving, longest-running first.

    A usage row is written when a request settles, so the log alone cannot answer
    "is anything happening right now": on a slow backend, a 30-second local model
    call is invisible until it finishes. This reports what is in progress.

    Read from an in-memory registry, so it describes the process that answers this
    call and not the deployment: behind a load balancer, consecutive polls reach
    different otari processes, and there is no deployment-wide total to ask for.
    ``total`` is the true in-flight count for the answering process even when
    ``requests`` is capped.
    """
    registry = get_registry(raw_request)
    if registry is None:
        return InFlightResponse(requests=[], total=0)
    entries = registry.snapshot()
    # One clock reading for the whole response, so two rows started together
    # report the same elapsed time.
    now = monotonic()
    return InFlightResponse(
        requests=[
            InFlightEntry(
                id=entry.id,
                endpoint=entry.endpoint,
                model=entry.model,
                provider=entry.provider,
                user_id=entry.user_id,
                api_key_id=entry.api_key_id,
                policy_name=entry.policy_name,
                started_at=entry.started_at,
                elapsed_ms=entry.elapsed_ms(now),
            )
            for entry in entries[:_MAX_IN_FLIGHT_ROWS]
        ],
        total=len(entries),
    )


@operator_router.delete("")
async def delete_usage_rows(
    request: UsageDeleteRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UsageDeleteResult:
    """Delete imported usage rows by explicit ids or by filter (standalone).

    Target either the current selection (``ids``) or everything matching a filter
    (``by_filter: true`` plus optional ``source`` / ``model`` / ``user_id`` /
    ``status`` / date range / ``priced``). Only imported rows
    (``counts_toward_budget = false``) are ever removed: enforced gateway rows and
    the spend ledger (``users.spend``) are untouched, so a delete can never desync a
    budget. Master-key only.
    """
    return await delete_usage(db, request)


@operator_router.post("/set-price")
async def set_usage_price_rows(
    request: UsageSetPriceRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
) -> UsageSetPriceResult:
    """Set the cost of imported usage rows from manual per-1M rates (standalone).

    Target either the current selection (``ids``) or everything matching a filter
    (``by_filter: true``). Cost / billing meters / pricing breakdown are recomputed
    from each row's own token counts at the supplied ``input`` / ``output`` /
    ``cache_read`` / ``cache_write`` per-1M rates (manual rates, not a recompute from
    configured pricing). Only imported rows (``counts_toward_budget = false``) are
    touched, so ``users.spend`` is never affected. Master-key only.
    """
    return await set_usage_price(db, request)


@operator_router.get("/summary")
async def usage_summary(
    reads: UsageReadServiceDep,
    filters: Annotated[UsageReadFilters, Depends()],
    bucket: UsageBucketGrain = Query(default="day", description=SUMMARY_BUCKET_DESC),
    dimensions: list[SummaryDimension] | None = Query(default=None, description=DIMENSIONS_DESC),
    include_p95: Annotated[bool, Query(description=INCLUDE_P95_DESC)] = False,
) -> UsageSummary:
    """Aggregate spend, tokens, and request volume for the dashboard Usage page.

    Range-bounded (default last 30 days, hard-capped): unlike the raw ``/api/v1/usage``
    list, every aggregate is scoped to a bounded window so it stays served by the
    timestamp index. Returns grand totals, breakdowns by model / user / API key /
    source / session (``source_label``) / endpoint / provider (top rows plus a
    reconciling ``other`` fold, billed token counts), the error taxonomy grouped
    by failure status code, and a UTC-bucketed time series carrying each bucket's
    error count and billed token composition (input incl. cache, cache read/write,
    output).

    Each breakdown is its own ``GROUP BY`` pass, so a caller that reads only the
    totals or the series should narrow ``dimensions`` rather than pay for all eight
    (the dashboard's tiles, timeline context, and model typeahead all do). Omitting
    the parameter keeps the full set.

    ``model``, ``user_id``, and ``api_key_id`` are repeatable: several values match
    any of them, so one chart can compare a handful of models, users, or keys.
    """
    start, end = summary_window(filters, grid=bucket if bucket == "5min" else None)
    return await reads.summary(
        start=start,
        end=end,
        conditions=filters.conditions(start_date=start, end_date=end, scope=None),
        status=filters.status,
        bucket=bucket,
        dimensions=dimensions,
        include_p95=include_p95,
    )


@operator_router.get("/series")
async def usage_series(
    reads: UsageReadServiceDep,
    filters: Annotated[UsageReadFilters, Depends()],
    group_by: SeriesGroupBy = Query(description="Dimension to split the series by"),
    bucket: Bucket = Query(default="day", description="Time-series granularity: 'hour' or 'day'"),
) -> UsageGroupedSeries:
    """Time series split by one dimension, for the dashboard's stacked charts.

    Same filters and window bounds as ``/summary`` (kept in lockstep: the
    dashboard serializes one filter object for both, and a filter this endpoint
    silently ignored would make the stacked chart disagree with the tiles beside
    it). The window's top groups by spend are returned as their own series;
    everything past the top eight folds into a single ``other`` series per
    bucket, so the stack always reconciles with the summary totals. Points are
    sparse (populated cells only); the bucket grid is bounded like ``/summary``'s
    series, so an hourly bucket over a too-wide window is rejected rather than
    ballooning the payload.
    """
    start, end = summary_window(filters, grid=bucket)
    return await reads.grouped_series(
        start=start,
        end=end,
        conditions=filters.conditions(start_date=start, end_date=end, scope=None),
        status=filters.status,
        bucket=bucket,
        group_by=group_by,
    )


@operator_router.get("/groups")
async def usage_activity_groups(
    reads: UsageReadServiceDep,
    filters: Annotated[UsageReadFilters, Depends()],
    group_by: ActivityGroupBy = Query(description=GROUP_BY_DESC),
    search: Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH, description=GROUP_SEARCH_DESC)] = None,
    order: Annotated[ActivityGroupOrder, Query(description=GROUP_ORDER_DESC)] = "recent",
    skip: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> UsageActivityGroups:
    """The activity log collapsed to one row per API key, session, model, user, policy or alias.

    Each group carries its request, failure and earlier-failed-attempt counts, the
    gateway's own and imported cost, billed tokens, summed latency, its time
    span and the models it used, most recently active first or busiest first. Same filters
    and window bounds as ``/summary``. To list a group's requests, filter
    ``GET /api/v1/usage`` to its key (``is_null`` for the group whose key is None)
    over the ``start_date``/``end_date`` returned here, with
    ``include_absorbed=false`` to match ``requests``.
    """
    start, end = resolve_window(filters.start_date, filters.end_date)
    conditions = filters.conditions(start_date=start, end_date=end, scope=None)
    return await reads.activity_groups(
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
