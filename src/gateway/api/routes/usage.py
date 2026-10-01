"""Bulk usage log endpoint.

Provides a single query interface over all usage logs with optional
time range and user filters, ordered newest-first. Intended for
external systems that need to sync usage data (billing, analytics).
"""

from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from time import monotonic
from typing import Annotated, Any, Literal, TypeVar, cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import ColumnElement, case, func, null, select
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
    GATEWAY_TOOL_NAMES,
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
)
from gateway.core.config import GatewayConfig
from gateway.core.database import get_ingest_db
from gateway.core.sql import (
    BUCKET_FORMATS,
    BUCKET_SECONDS,
    UsageBucketGrain,
    bucket_expr,
    canonical_bucket,
    dialect_name,
)
from gateway.core.surface import Surface
from gateway.core.usage_filters import (
    API_KEY_LABEL,
    MAX_SEARCH_LENGTH,
    TOOL_METER_NAMESPACE,
    USER_LABEL,
    LabelJoin,
    SortOrder,
    UsageSort,
    billed_input_sum,
    billed_meter,
    billed_output_sum,
    list_window,
    needs_pricing_condition,
    request_count,
    resolve_window,
    tool_calls_expr,
)
from gateway.core.usage_source import is_served_here, not_served_here
from gateway.inflight import get_registry
from gateway.models.api_keys import APIKey
from gateway.models.money import as_float
from gateway.models.usage import UsageLog
from gateway.schemas.usage import ActivityGroupBy, ActivityGroupOrder, UsageActivityGroup, UsageActivityGroups
from gateway.services.external_usage_service import (
    ExternalEventsRequest,
    ExternalIngestResult,
    ingest_external_events,
)
from gateway.services.usage import UsageReadService
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

# How many rows each breakdown returns before the remainder is folded into a
# single synthesized "other" row (so the tables still reconcile with the totals).
_BREAKDOWN_TOP_N = 100

# How many groups a grouped time series carries before the remainder folds into
# "other". Eight is the ceiling a stacked chart can keep legible (and the size of
# the dashboard's fixed categorical palette); the breakdown tables, not the chart,
# are the place to read a longer tail.
_SERIES_TOP_N = 8

# How many in-flight requests are serialized. A live panel is read at a glance, so
# a fixed cap beats a pagination knob; the response reports the true count next to
# the capped list, and the longest-running are the ones kept.
_MAX_IN_FLIGHT_ROWS = 50

# Sessions (``source_label``) are an order of magnitude higher-cardinality than
# models or users: one agent workload can open hundreds of them in a month, and
# the interesting signal is a long-ish head ("which tasks burned the budget"),
# not just the top few. Give that dimension a deeper cap so the head is not
# swallowed by the "other" fold.
_SESSION_BREAKDOWN_TOP_N = 250

# The grid the grouped series and the agent-telemetry series share with the telemetry
# port; only the summary's own series also takes five minutes.
Bucket = Literal["hour", "day"]
SeriesGroupBy = Literal["model", "user_id", "api_key_id", "source"]

# Coarse display buckets for a failure's status code. A closed Literal rather than
# a bare str so the set lands in the OpenAPI schema as an enum and a consumer can
# switch on it exhaustively instead of string-matching whatever the server sent.
ErrorClass = Literal["pricing", "rate_limit", "auth", "provider_error", "client_error", "unknown"]


# Every breakdown ``/summary`` can compute, mapped to the column it groups by and
# its top-N cap. A dimension name is the ``by_<name>`` response field it fills, so
# a caller reads the selector and the payload with one vocabulary.
_SUMMARY_DIMENSIONS: dict[str, tuple[Any, int, "LabelJoin | None"]] = {
    "model": (UsageLog.model, _BREAKDOWN_TOP_N, None),
    "user": (UsageLog.user_id, _BREAKDOWN_TOP_N, USER_LABEL),
    "api_key": (UsageLog.api_key_id, _BREAKDOWN_TOP_N, API_KEY_LABEL),
    "source": (UsageLog.source, _BREAKDOWN_TOP_N, None),
    "source_label": (UsageLog.source_label, _SESSION_BREAKDOWN_TOP_N, None),
    "endpoint": (UsageLog.endpoint, _BREAKDOWN_TOP_N, None),
    "provider": (UsageLog.provider, _BREAKDOWN_TOP_N, None),
}

# The failure taxonomy (``errors_by_status_code``) is a GROUP BY pass like the
# breakdowns above, but it groups failures by status code rather than spend by a
# dimension, so it is selectable by name without living in _SUMMARY_DIMENSIONS.
# It is the one dimension whose response field is not ``by_<name>``.
_ERROR_TAXONOMY_DIMENSION = "status_code"

# Keep in step with _SUMMARY_DIMENSIONS; the extra ``none`` is the explicit empty
# selection (a repeated query param cannot express an empty list on the wire).
SummaryDimension = Literal[
    "model", "user", "api_key", "source", "source_label", "endpoint", "provider", "status_code", "tool", "none"
]

_TOOL_DIMENSION = "tool"
_ALL_SUMMARY_DIMENSIONS: set[str] = set(_SUMMARY_DIMENSIONS) | {_ERROR_TAXONOMY_DIMENSION, _TOOL_DIMENSION}


def _utc_iso(value: datetime) -> str:
    """Serialize a stored timestamp as unambiguous UTC ISO-8601.

    ``usage_logs.timestamp`` is timezone-aware, but SQLite returns it naive (it does
    not persist the offset). A naive ``isoformat()`` has no ``+00:00``, so a browser
    reads it in its own local zone and a recent UTC event can land in the future,
    showing as "0s ago". Treat a naive value as the UTC it was stored as.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


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


async def _list_usage_entries(
    reads: UsageReadService,
    conditions: list[ColumnElement[bool]],
    *,
    scope: ColumnElement[bool] | None,
    skip: int,
    limit: int,
    sort: UsageSort,
    order: SortOrder,
) -> list[UsageEntry]:
    """A page of usage rows in the requested order, with their display labels and earlier failed attempts.

    Shared by the deployment-wide and the organization-scoped list so the two cannot
    drift. ``scope`` is the predicate already in ``conditions``, needed again to
    count the attempts.
    """
    rows = await reads.page(conditions, scope=scope, sort=sort, order=order, skip=skip, limit=limit)
    return [
        UsageEntry.from_model(
            row.log,
            user_alias=row.user_alias,
            api_key_name=row.api_key_name,
            absorbed_attempts=row.absorbed_attempts,
        )
        for row in rows
    ]


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
    return await _list_usage_entries(reads, conditions, scope=None, skip=skip, limit=limit, sort=sort, order=order)


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


# ---------------------------------------------------------------------------
# Aggregated analytics (dashboard Usage page). Separate from the bare-array
# list above, which stays a stable external-consumer contract.
# ---------------------------------------------------------------------------


class UsageTotals(BaseModel):
    """Grand totals over the filtered window."""

    cost: float
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cache_write_1h_tokens: int
    request_count: int
    error_count: int
    avg_latency_ms: float | None
    # Served rows with no configured price (cost is NULL), e.g. imported usage for
    # an unpriced model. Surfaced so a $0 cost is not mistaken for free usage.
    # Scoped to status="success": a gateway-side rejection also carries cost=NULL
    # (nothing was spent), so counting error rows here would make a budget or
    # allow-list incident read as a pricing misconfiguration.
    unpriced_requests: int = 0
    # Billed input tokens (fresh input plus both cache buckets), normalized via
    # each row's billing meters where present (see ``billed_meter``). Unlike
    # ``prompt_tokens`` this is convention-independent, so cache hit rate
    # (cache_read_tokens / billed_input_tokens) is meaningful across providers.
    billed_input_tokens: int = 0
    # Billed output tokens, normalized the same way, so the breakdown fold row
    # reconciles against the same quantity the per-group rows sum (a raw
    # ``completion_tokens`` residual would drift, even negative, whenever a
    # row's meter and column disagree).
    billed_output_tokens: int = 0
    # Nearest-rank 95th-percentile latency over requests, excluding absorbed
    # attempts as ``avg_latency_ms`` does. Null unless ``include_p95`` was set, and
    # when no request recorded a latency.
    p95_latency_ms: int | None = None
    # Rows of routed requests' earlier failed attempts (status ``absorbed``), which
    # ``request_count`` and ``error_count`` leave out.
    absorbed_count: int = 0
    # The part of ``cost`` that came from imported usage (rows this deployment did
    # not serve, such as a Claude Code subscription's). It is what that usage
    # would have cost at API rates, never charged to a budget, so a caller shows
    # it apart from the gateway's own spend (``cost - imported_cost``).
    imported_cost: float = 0.0


class UsageGroupRow(BaseModel):
    """One breakdown row (a model, a user, an API key, a session, ...).

    ``key`` is None both for the synthesized fold row (``is_other=True``) and for a
    real group whose column was NULL (e.g. usage from a since-deleted user, with
    ``is_other=False``). ``is_other`` disambiguates the two so the UI does not
    mislabel deleted-user usage as the fold.
    """

    key: str | None
    # Display name for an opaque key (a user's alias, an API key's name), resolved
    # in the same GROUP BY. Only ever set for the ``user`` and ``api_key``
    # dimensions, and null there too when the entity has no label or is gone; a
    # client falls back to ``key``. Its purpose is to let a client build a user or
    # key filter from this breakdown alone, rather than reading both whole tables.
    label: str | None = None
    cost: float
    tokens: int
    requests: int
    is_other: bool = False


class UsageErrorCodeRow(BaseModel):
    """One error-taxonomy row: the failures in the window sharing a status code.

    ``status_code`` is None for failures recorded without one (rows written
    before the column existed, and failures no HTTP status describes, e.g. a
    stream that finished without usage data under the ``fail`` policy).
    ``error_class`` is the coarse display bucket derived from the code, so a UI
    can group "provider fault" against "my own misconfiguration" without
    re-deriving a status ladder; the raw code stays alongside it for precision.
    """

    status_code: int | None
    error_class: ErrorClass
    requests: int


class UsageSeriesPoint(BaseModel):
    """One time bucket. ``bucket_start`` is canonical ISO-8601 UTC (``...Z``),
    identical across SQLite and PostgreSQL for the same underlying instant.

    ``tokens`` stays the raw provider-reported total (the field predates the
    composition split and external consumers may read it). The billed
    composition fields are normalized via billing meters (see ``billed_meter``):
    ``input_tokens`` includes both cache buckets, so a chart derives fresh input
    as ``max(0, input_tokens - cache_read_tokens - cache_write_tokens)`` and the
    billed total as ``fresh + cache_read + cache_write + output``.
    """

    bucket_start: str
    cost: float
    tokens: int
    requests: int
    errors: int = 0
    input_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0


class UsageToolRow(BaseModel):
    """Spend and volume for one gateway-run tool inside the window.

    ``calls`` counts billable calls, not requests: one request can run a tool
    several times, which is the whole reason a per-tool view exists. ``errors``
    counts calls that failed and were therefore never billed. ``requests`` is how
    many requests ran the tool at least once, so the number reconciles with the
    Activity list when the same filter is applied there.
    """

    tool: str
    calls: int
    errors: int
    requests: int
    cost: float


class UsageSummary(BaseModel):
    """Aggregate spend/volume for the Usage & analytics page.

    Every breakdown field is always present. One the caller excluded through
    ``dimensions`` comes back as an empty list, the same shape a window with no
    matching rows produces, so narrowing the selector never changes the schema.
    """

    start_date: str
    end_date: str
    bucket: UsageBucketGrain
    totals: UsageTotals
    by_model: list[UsageGroupRow]
    by_user: list[UsageGroupRow]
    by_api_key: list[UsageGroupRow]
    by_source: list[UsageGroupRow]
    # Session/project attribution for agent traffic: a handful of long-running
    # sessions routinely account for most of a workload's tokens, so this is the
    # dimension that turns "spend went up" into "this task went wrong". Gateway
    # rows carry no label, so they group under a single null key.
    by_source_label: list[UsageGroupRow]
    # API surface (/api/v1/chat/completions vs /api/v1/messages vs /api/v1/responses) and
    # upstream provider: the two splits a gateway operator needs and that no
    # other endpoint reports.
    by_endpoint: list[UsageGroupRow]
    by_provider: list[UsageGroupRow]
    # Gateway-run tool spend. Empty when the window has none, and MCP tools are
    # excluded by design (their names are unbounded, see GATEWAY_TOOL_NAMES).
    by_tool: list[UsageToolRow] = []
    # Failures only, so the taxonomy is not swamped by the successes that carry
    # no status code. Counts sum to ``totals.error_count``, unless a window
    # somehow held more than ``_BREAKDOWN_TOP_N`` distinct codes, in which case
    # the tail is omitted rather than folded (there is no synthesized "other"
    # row: a null key would collide with the real "no code recorded" group).
    errors_by_status_code: list[UsageErrorCodeRow]
    series: list[UsageSeriesPoint]


class UsageGroupedSeriesPoint(BaseModel):
    """One (time bucket, group) cell of a grouped series.

    ``key``/``is_other`` follow the ``UsageGroupRow`` convention: ``key=None``
    with ``is_other=True`` is the fold of groups outside the top N, ``key=None``
    with ``is_other=False`` is a real NULL group (e.g. a deleted user).
    ``tokens`` is the *billed* total (input including cache, plus output), the
    same quantity the ungrouped series' composition fields sum to.
    """

    bucket_start: str
    key: str | None
    is_other: bool = False
    cost: float
    tokens: int
    requests: int


class UsageGroupedSeries(BaseModel):
    """A per-group time series for the dashboard's stacked charts.

    ``groups`` ranks the window's top groups by spend (plus the reconciling
    ``other`` fold), in the order a chart should stack and color them; ``points``
    is sparse (only populated cells), keyed by canonical UTC ``bucket_start``.
    """

    start_date: str
    end_date: str
    bucket: Bucket
    group_by: SeriesGroupBy
    groups: list[UsageGroupRow]
    points: list[UsageGroupedSeriesPoint]


def _bucket_expr(dialect: str, bucket: UsageBucketGrain, column: Any = None) -> Any:
    """``core.sql.bucket_expr`` defaulted to ``usage_logs.timestamp``.

    The grid itself is shared code, because the telemetry storage adapters
    bucket on it too and a chart built from both sides lines up only if every
    producer truncates identically.
    """
    return bucket_expr(dialect, bucket, UsageLog.timestamp if column is None else column)


def _tool_cost_expr(tool: str) -> Any:
    """USD charged for one tool on a row, read off its own charge line.

    The row's ``cost`` mixes tokens and tools, so per-tool spend has to come from
    the line ``price_tool_calls`` wrote. ``pricing_breakdown`` is a JSON *array*,
    and the tool lines are appended after the token ones, so the position is not
    fixed; the units and the rate are both on the line, so the product is
    reconstructed from the meter count instead, which needs no array search.
    """
    return tool_calls_expr(tool) * _tool_unit_rate_expr(tool)


def _tool_unit_rate_expr(tool: str) -> Any:
    """Per-call USD rate recorded on the row for one tool.

    Stored per row rather than looked up live, so a historical row keeps the rate
    it was actually billed at even after the operator changes the price.
    """
    return func.coalesce(
        UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "unit_rate")].as_float(),
        0.0,
    )


# The billed composition aggregates shared by the summary series, the grand
# totals, and the grouped series, so all three reconcile by construction.
async def _totals(
    db: AsyncSession, conditions: list[ColumnElement[bool]], status_filter: str | None = None
) -> UsageTotals:
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageLog.cost), 0.0),
                func.coalesce(func.sum(UsageLog.prompt_tokens), 0),
                func.coalesce(func.sum(UsageLog.completion_tokens), 0),
                func.coalesce(func.sum(UsageLog.total_tokens), 0),
                func.coalesce(func.sum(UsageLog.cache_read_tokens), 0),
                func.coalesce(func.sum(UsageLog.cache_write_tokens), 0),
                func.coalesce(func.sum(UsageLog.cache_write_1h_tokens), 0),
                request_count(status_filter),
                func.coalesce(func.sum(case((UsageLog.status == "error", 1), else_=0)), 0),
                # Averaged over requests, not attempts: an absorbed row carries the
                # time spent on a candidate that did not serve, and folding it in
                # would make a policy that recovers quickly look slower than one
                # that never fails.
                func.avg(case((UsageLog.status != "absorbed", UsageLog.latency_ms))),
                # Unpriced *served* rows only; see UsageTotals.unpriced_requests. The
                # predicate is shared with the list filter so the tile and the rows it
                # sends an operator to agree.
                func.coalesce(
                    func.sum(case(((UsageLog.status == "success") & needs_pricing_condition(), 1), else_=0)),
                    0,
                ),
                billed_input_sum(),
                billed_output_sum(),
                func.coalesce(func.sum(case((UsageLog.status == "absorbed", 1), else_=0)), 0),
                func.coalesce(func.sum(case((not_served_here(UsageLog.source), UsageLog.cost), else_=0)), 0.0),
            ).where(*conditions)
        )
    ).one()
    return UsageTotals(
        cost=float(row[0]),
        prompt_tokens=int(row[1]),
        completion_tokens=int(row[2]),
        total_tokens=int(row[3]),
        cache_read_tokens=int(row[4]),
        cache_write_tokens=int(row[5]),
        cache_write_1h_tokens=int(row[6]),
        request_count=int(row[7]),
        error_count=int(row[8]),
        avg_latency_ms=float(row[9]) if row[9] is not None else None,
        unpriced_requests=int(row[10]),
        billed_input_tokens=int(row[11]),
        billed_output_tokens=int(row[12]),
        absorbed_count=int(row[13]),
        imported_cost=float(row[14]),
    )


async def _breakdown(
    db: AsyncSession,
    column: Any,
    conditions: list[ColumnElement[bool]],
    totals: UsageTotals,
    *,
    limit: int | None,
    status_filter: str | None = None,
    label_join: "LabelJoin | None" = None,
) -> list[UsageGroupRow]:
    """Spend/tokens/requests grouped by ``column``, biggest spend first.

    ``tokens`` is the *billed* total (input including both cache buckets, plus
    output, via ``billed_meter``), the same quantity the series composition and
    the grouped series report, so every analytics surface agrees on what a
    token count means. When ``limit`` is set, only the top rows are returned and
    the remainder is folded into a synthesized ``other`` row derived from the
    grand totals, so the breakdown always reconciles with the tiles.
    ``limit=None`` returns every group. No route asks for that today: the CSV
    export did, and it was removed with nothing having called it since the
    dashboard dropped its download (mozilla-ai/otari#842's follow-up). The arm
    stays because it is what makes the fold optional rather than assumed, and a
    caller that must not truncate is the next thing to want it.
    """
    cost_sum = func.coalesce(func.sum(UsageLog.cost), 0.0)
    # The label rides along in the same pass rather than costing a second query or
    # a client-side table dump. Grouped by as well as selected: it is functionally
    # dependent on the joined row's primary key, but only PostgreSQL infers that,
    # and this has to run on SQLite too. Outer-joined so a group whose entity was
    # deleted keeps its row (with a null label) instead of vanishing from a
    # breakdown that must still reconcile against the totals.
    label_column = label_join.label if label_join is not None else null()
    stmt = select(
        column,
        label_column,
        cost_sum,
        billed_input_sum() + billed_output_sum(),
        request_count(status_filter),
    )
    if label_join is not None:
        stmt = stmt.outerjoin(label_join.entity, label_join.on)
    group_by = (column,) if label_join is None else (column, label_column)
    stmt = stmt.where(*conditions).group_by(*group_by).order_by(cost_sum.desc())
    if limit is not None:
        stmt = stmt.limit(limit)
    rows = (await db.execute(stmt)).all()
    result = [
        UsageGroupRow(key=row[0], label=row[1], cost=float(row[2]), tokens=int(row[3]), requests=int(row[4]))
        for row in rows
    ]
    if limit is not None:
        seen_requests = sum(r.requests for r in result)
        # request_count is an exact integer, so a positive residual is the reliable
        # signal that groups were folded; cost/tokens residuals follow from totals.
        residual_requests = totals.request_count - seen_requests
        if residual_requests > 0:
            billed_total = totals.billed_input_tokens + totals.billed_output_tokens
            result.append(
                UsageGroupRow(
                    key=None,
                    cost=totals.cost - sum(r.cost for r in result),
                    tokens=billed_total - sum(r.tokens for r in result),
                    requests=residual_requests,
                    is_other=True,
                )
            )
    return result


def error_class_for(status_code: int | None) -> ErrorClass:
    """Coarse display bucket for a failure's HTTP status code.

    Two kinds of code reach this column: the status a provider returned, and the
    status the gateway itself refused with, since #465 records those rejections
    too and each row carries the code it returned (403 for a blocked or
    over-budget user, a user/key mismatch, or a model outside a key's allow-list,
    402 for missing pricing, 400 for a selector that no longer resolves).

    So ``auth`` currently covers both a provider rejecting the gateway's
    credentials and the gateway rejecting the caller, and a **budget denial files
    as ``auth``**, because ``reserve_budget`` refuses with 403 and the code is all
    this function sees. Splitting budget and permission refusals into their own
    class needs a discriminator the row does not reliably carry (``provider`` is
    NULL only on the gates that refuse before the selector resolves, not on the
    budget gate), and these names are dashboard-visible, so that stays a
    deliberate follow-up rather than something guessed at here.
    """
    if status_code is None:
        return "unknown"
    if status_code == 402:
        return "pricing"
    if status_code == 429:
        return "rate_limit"
    if status_code in (401, 403, 407):
        return "auth"
    if 500 <= status_code <= 599:
        return "provider_error"
    if 400 <= status_code <= 499:
        return "client_error"
    return "unknown"


async def _tool_breakdown(
    db: AsyncSession,
    conditions: list[ColumnElement[bool]],
) -> list[UsageToolRow]:
    """Per-tool calls, failures, spend, and requests inside the window.

    One aggregate per known tool rather than a ``GROUP BY`` over the meter map:
    a JSON map's keys cannot be grouped portably across SQLite and PostgreSQL
    (``json_each`` versus ``jsonb_each``), and the set
    of gateway-run tools is small and fixed. Cost comes from each row's charge
    line rather than the row total, because a row's ``cost`` also carries tokens.

    Rows with no calls for a tool contribute nothing, so a deployment that never
    ran a tool gets an empty list and the UI can hide the section entirely.

    ``calls`` and ``errors`` count every call a request made, including calls made by
    an attempt a routing policy later abandoned: the tally is shared across a
    request's attempts and settled onto the row that served, so those calls are on
    that one row rather than spread across the absorbed ones. ``requests`` counts
    requests, so the two answer different questions on purpose: "how much tool work
    did we do" and "how many requests used a tool".
    """
    out: list[UsageToolRow] = []
    for tool in GATEWAY_TOOL_NAMES:
        calls = tool_calls_expr(tool)
        errors = UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "errors")].as_integer()
        row = (
            await db.execute(
                select(
                    func.coalesce(func.sum(calls), 0),
                    func.coalesce(func.sum(errors), 0),
                    # Requests, not rows: a request that failed over through a
                    # routing policy writes an absorbed row per recovered attempt,
                    # and counting those would report more requests using a tool
                    # than the Activity list shows for the same filter.
                    request_count(),
                    func.coalesce(func.sum(_tool_cost_expr(tool)), 0.0),
                ).where(*conditions, calls.is_not(None))
            )
        ).one()
        if not row[0] and not row[1]:
            continue
        out.append(
            UsageToolRow(
                tool=tool,
                calls=int(row[0]),
                errors=int(row[1]),
                requests=int(row[2]),
                cost=float(row[3]),
            )
        )
    return sorted(out, key=lambda r: r.cost, reverse=True)


async def _errors_by_status_code(
    db: AsyncSession,
    conditions: list[ColumnElement[bool]],
) -> list[UsageErrorCodeRow]:
    """Failures in the window grouped by status code, most frequent first.

    The whole point of the column: this is a GROUP BY rather than substring
    matching over provider-specific error prose. Capped at ``_BREAKDOWN_TOP_N``
    distinct codes, which no real window reaches (HTTP has far fewer), so unlike
    the cost breakdowns there is no synthesized fold row.
    """
    request_count = func.count()
    rows = (
        await db.execute(
            select(UsageLog.status_code, request_count)
            .where(*conditions, UsageLog.status == "error")
            .group_by(UsageLog.status_code)
            .order_by(request_count.desc())
            .limit(_BREAKDOWN_TOP_N)
        )
    ).all()
    return [
        UsageErrorCodeRow(
            status_code=row[0],
            error_class=error_class_for(row[0]),
            requests=int(row[1]),
        )
        for row in rows
    ]


async def _summary_context(
    db: AsyncSession,
    filters: UsageReadFilters,
    *,
    grid: UsageBucketGrain | None = None,
    scope: ColumnElement[bool] | None,
) -> tuple[datetime, datetime, list[ColumnElement[bool]], UsageTotals]:
    """Resolve the bounded window, the shared WHERE conditions, and the grand
    totals: the common preamble both summary endpoints run, kept in one place so a
    fix (like the naive-datetime handling in ``resolve_window``) lands once.
    ``grid`` refuses a window too wide for that bucket before anything is queried.
    """
    start, end = resolve_window(filters.start_date, filters.end_date)
    if grid is not None:
        _refuse_wide_grid(start, end, grid)
    conditions = filters.conditions(start_date=start, end_date=end, scope=scope)
    totals = await _totals(db, conditions, filters.status)
    return start, end, conditions, totals


# Upper bound on zero-filled series points, so a pathological range/bucket combo
# (e.g. hourly over a year) cannot balloon the payload; beyond it the endpoint
# returns the sparse populated buckets instead.
_MAX_SERIES_POINTS = 1000


def _refuse_wide_grid(start: datetime, end: datetime, bucket: UsageBucketGrain) -> None:
    """Refuse a window with more than ``_MAX_SERIES_POINTS`` buckets of ``bucket``.

    For the series that stay sparse, and for five-minute buckets, which a
    too-wide window would otherwise turn into a payload of tens of thousands of
    points. Called before any query runs. Measured from the bucket ``start`` falls
    in, as the dense series counts its points, so a window that fits is never one
    point too long for it.
    """
    if (end - _grid_start(start, bucket)).total_seconds() > _MAX_SERIES_POINTS * BUCKET_SECONDS[bucket]:
        coarser = "hour" if bucket == "5min" else "day"
        raise HTTPException(
            status_code=422,
            detail=(
                f"window spans more than {_MAX_SERIES_POINTS} {bucket} buckets; "
                f"use bucket={coarser} or narrow the range"
            ),
        )


def _grid_start(start: datetime, bucket: UsageBucketGrain) -> datetime:
    """The start of the UTC bucket ``start`` falls in. Bucket starts are whole multiples of the step since the epoch."""
    seconds = BUCKET_SECONDS[bucket]
    return datetime.fromtimestamp(start.timestamp() // seconds * seconds, UTC)


_PointT = TypeVar("_PointT")


def _empty_usage_point(bucket_start: str) -> UsageSeriesPoint:
    return UsageSeriesPoint(bucket_start=bucket_start, cost=0.0, tokens=0, requests=0)


def _dense_series(
    start: datetime,
    end: datetime,
    bucket: UsageBucketGrain,
    populated: dict[str, _PointT],
    empty: Callable[[str], _PointT] | None = None,
) -> list[_PointT]:
    """Fill every bucket in ``[floor(start), end)`` so the chart's x-axis is linear
    in time. ``GROUP BY`` omits empty buckets, so without this a sparse range (say
    usage on day 1 and day 20 of a month) would render as two adjacent bars and
    misread the trend. Falls back to the sparse buckets past ``_MAX_SERIES_POINTS``.
    An empty window (no rows at all) returns an empty series, not a wall of zeros.

    ``empty`` builds the zero point for a gap; it is what lets another series type
    (the agent-telemetry summary's) share this fill rather than restate it.
    """
    if not populated:
        return []
    make_empty = cast("Callable[[str], _PointT]", empty or _empty_usage_point)
    step = timedelta(seconds=BUCKET_SECONDS[bucket])
    fmt = BUCKET_FORMATS[bucket]
    cursor = _grid_start(start, bucket)
    points: list[_PointT] = []
    while cursor < end:
        if len(points) >= _MAX_SERIES_POINTS:
            return [populated[key] for key in sorted(populated)]
        key = cursor.strftime(fmt)
        points.append(populated.get(key) or make_empty(key))
        cursor += step
    return points


async def _summary_response(
    db: AsyncSession,
    reads: UsageReadService,
    *,
    start: datetime,
    end: datetime,
    conditions: list[ColumnElement[bool]],
    totals: UsageTotals,
    status: str | None,
    bucket: UsageBucketGrain,
    dimensions: list[SummaryDimension] | None,
    include_p95: bool = False,
) -> UsageSummary:
    """Assemble the summary from an already-resolved window and condition set.

    Split from the route so the organization-scoped copy of this endpoint runs
    the same aggregation rather than a second one that could drift from it: the
    only thing the two differ in is the scope predicate already folded into
    ``conditions``.
    """
    # ``none`` is dropped rather than rejected: it exists only so a caller can send
    # an empty selection, and it never contributes a dimension of its own.
    requested: set[str] = _ALL_SUMMARY_DIMENSIONS if dimensions is None else {d for d in dimensions if d != "none"}
    breakdowns = {
        name: await _breakdown(db, column, conditions, totals, limit=cap, status_filter=status, label_join=label)
        for name, (column, cap, label) in _SUMMARY_DIMENSIONS.items()
        if name in requested
    }
    # The failure taxonomy is a GROUP BY pass like the others, so it answers to the
    # same selector rather than being charged to every caller: the tiles and the
    # timeline ask for no dimensions at all.
    errors_by_status_code = (
        await _errors_by_status_code(db, conditions) if _ERROR_TAXONOMY_DIMENSION in requested else []
    )
    by_tool = await _tool_breakdown(db, conditions) if _TOOL_DIMENSION in requested else []
    if include_p95:
        p95 = await reads.p95_latency_ms(conditions)
        totals = totals.model_copy(update={"p95_latency_ms": p95})

    expr = _bucket_expr(dialect_name(db), bucket)
    series_rows = (
        await db.execute(
            select(
                expr,
                func.coalesce(func.sum(UsageLog.cost), 0.0),
                func.coalesce(func.sum(UsageLog.total_tokens), 0),
                request_count(status),
                func.coalesce(func.sum(case((UsageLog.status == "error", 1), else_=0)), 0),
                billed_input_sum(),
                func.coalesce(func.sum(billed_meter("cache_read_tokens", UsageLog.cache_read_tokens)), 0),
                func.coalesce(func.sum(billed_meter("cache_write_tokens", UsageLog.cache_write_tokens)), 0),
                billed_output_sum(),
            )
            .where(*conditions)
            .group_by(expr)
        )
    ).all()
    # Zero-fill empty buckets so the chart is time-linear (GROUP BY drops gaps).
    populated = {
        canonical_bucket(row[0], bucket): UsageSeriesPoint(
            bucket_start=canonical_bucket(row[0], bucket),
            cost=float(row[1]),
            tokens=int(row[2]),
            requests=int(row[3]),
            errors=int(row[4]),
            input_tokens=int(row[5]),
            cache_read_tokens=int(row[6]),
            cache_write_tokens=int(row[7]),
            output_tokens=int(row[8]),
        )
        for row in series_rows
    }
    series = _dense_series(start, end, bucket, populated)

    return UsageSummary(
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        bucket=bucket,
        totals=totals,
        by_model=breakdowns.get("model", []),
        by_user=breakdowns.get("user", []),
        by_api_key=breakdowns.get("api_key", []),
        by_source=breakdowns.get("source", []),
        by_source_label=breakdowns.get("source_label", []),
        by_endpoint=breakdowns.get("endpoint", []),
        by_provider=breakdowns.get("provider", []),
        by_tool=by_tool,
        errors_by_status_code=errors_by_status_code,
        series=series,
    )


@operator_router.get("/summary")
async def usage_summary(
    db: Annotated[AsyncSession, Depends(get_db)],
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
    start, end, conditions, totals = await _summary_context(
        db, filters, grid=bucket if bucket == "5min" else None, scope=None
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


_GROUP_COLUMNS: dict[str, tuple[Any, "LabelJoin | None"]] = {
    "model": (UsageLog.model, None),
    "user_id": (UsageLog.user_id, USER_LABEL),
    "api_key_id": (UsageLog.api_key_id, API_KEY_LABEL),
    "source": (UsageLog.source, None),
}


async def _grouped_series_response(
    db: AsyncSession,
    *,
    start: datetime,
    end: datetime,
    conditions: list[ColumnElement[bool]],
    totals: UsageTotals,
    status: str | None,
    bucket: Bucket,
    group_by: SeriesGroupBy,
) -> UsageGroupedSeries:
    """Assemble the grouped series, for the same reason :func:`_summary_response` exists."""
    column, label_join = _GROUP_COLUMNS[group_by]
    groups = await _breakdown(
        db, column, conditions, totals, limit=_SERIES_TOP_N, status_filter=status, label_join=label_join
    )

    # One grouped query for the whole grid: groups outside the top N collapse
    # into the fold in SQL rather than being fetched and folded here, so the row
    # count stays bounded by buckets × (top N + 2) regardless of cardinality.
    # The synthesized groups are encoded as (key NULL, fold flag) rather than a
    # sentinel key string: GROUP BY treats NULLs as equal on both dialects, and
    # no sentinel can be trusted never to collide with a real key. A NULL column
    # value never matches ``IN``, so it lands in the CASE's ``else`` arm; the
    # fold flag then separates a NULL group that ranked in the top N (a real
    # ``key=None`` series, e.g. a deleted user) from the past-top-N remainder.
    named = {g.key for g in groups if g.key is not None}
    keeps_null = any(g.key is None and not g.is_other for g in groups)
    key_expr = case((column.in_(named), column), else_=null())
    if keeps_null:
        fold_expr = case((column.is_(None), 0), (column.in_(named), 0), else_=1)
    else:
        fold_expr = case((column.in_(named), 0), else_=1)
    bucket_expr = _bucket_expr(dialect_name(db), bucket)
    rows = (
        await db.execute(
            select(
                bucket_expr,
                key_expr,
                fold_expr,
                func.coalesce(func.sum(UsageLog.cost), 0.0),
                billed_input_sum() + billed_output_sum(),
                request_count(status),
            )
            .where(*conditions)
            .group_by(bucket_expr, key_expr, fold_expr)
        )
    ).all()

    points = [
        UsageGroupedSeriesPoint(
            bucket_start=canonical_bucket(row[0], bucket),
            key=row[1],
            is_other=bool(row[2]),
            cost=float(row[3]),
            tokens=int(row[4]),
            requests=int(row[5]),
        )
        for row in rows
    ]
    points.sort(key=lambda p: p.bucket_start)

    return UsageGroupedSeries(
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        bucket=bucket,
        group_by=group_by,
        groups=groups,
        points=points,
    )


@operator_router.get("/series")
async def usage_series(
    db: Annotated[AsyncSession, Depends(get_db)],
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
    start, end, conditions, totals = await _summary_context(db, filters, grid=bucket, scope=None)
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


# ---------------------------------------------------------------------------
# Activity groups: the log collapsed to one row per key, session, model, user,
# policy or alias.
# ---------------------------------------------------------------------------


async def _activity_groups_response(
    reads: UsageReadService,
    *,
    group_by: ActivityGroupBy,
    start: datetime,
    end: datetime,
    conditions: list[ColumnElement[bool]],
    status: str | None,
    search: str | None,
    order: ActivityGroupOrder,
    skip: int,
    limit: int,
) -> UsageActivityGroups:
    """A page of activity groups over an already-resolved window and condition set.

    Shared by the deployment-wide and the organization-scoped route, like
    :func:`_summary_response`, so the two run one aggregation.
    """
    rows, total = await reads.activity_groups(
        group_by=group_by,
        conditions=conditions,
        status=status,
        search=search,
        order=order,
        skip=skip,
        limit=limit,
    )
    return UsageActivityGroups(
        start_date=start.isoformat(),
        end_date=end.isoformat(),
        group_by=group_by,
        total=total,
        groups=[
            UsageActivityGroup(
                key=row.key,
                label=row.label,
                requests=row.requests,
                errors=row.errors,
                absorbed=row.absorbed,
                cost=row.cost,
                imported_cost=row.imported_cost,
                input_tokens=row.input_tokens,
                output_tokens=row.output_tokens,
                cache_read_tokens=row.cache_read_tokens,
                latency_ms=row.latency_ms,
                first_at=_utc_iso(row.first_at),
                last_at=_utc_iso(row.last_at),
                models=row.models,
                model_count=row.model_count,
            )
            for row in rows
        ],
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
