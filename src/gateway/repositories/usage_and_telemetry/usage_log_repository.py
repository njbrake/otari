"""Data access for ``usage_logs``, one row per attempt the gateway served or imported. Flushes, never commits."""

import uuid
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Never, cast

from sqlalchemy import (
    BigInteger,
    ColumnElement,
    CursorResult,
    Float,
    Numeric,
    Select,
    Subquery,
    and_,
    case,
    delete,
    false,
    func,
    insert,
    literal,
    null,
    or_,
    select,
    true,
    union_all,
    update,
)
from sqlalchemy import cast as sql_cast

from gateway.core.metered_pricing import ChargeLine
from gateway.core.sql import bucket_expr, canonical_bucket, dialect_name, match_any, utc_bound
from gateway.core.unit_of_work import UnitOfWork
from gateway.models.usage import (
    PLAYGROUND_USAGE_ENDPOINT,
    SERVED_HERE_SLUG,
    UsageLog,
    UsageRollup,
    UsageRollupDirtyHour,
)
from gateway.repositories.base_repository import BaseRepository
from gateway.schemas.usage_and_telemetry import (
    ANY_TOOL,
    GATEWAY_TOOL_NAMES,
    TOOL_METER_NAMESPACE,
    Bucket,
    SortOrder,
    UsageGroupedSeriesPoint,
    UsageGroupRow,
    UsageSeriesPoint,
    UsageSort,
    UsageToolRow,
    UsageTotals,
    UsageValueGroup,
    ValueGroupBy,
)

# The statuses that end a request. ``absorbed`` is an attempt a later one recovered
# from, so counting it would count one request twice.
_REQUEST_STATUSES = ("success", "error", "incomplete")


def new_usage_row(
    *,
    workspace_id: uuid.UUID,
    api_key_id: str | None,
    user_id: str,
    model: str,
    provider: str | None,
    endpoint: str,
    status: str,
    latency_ms: int,
    counts_toward_budget: bool,
    request_group_id: str,
    error_message: str | None = None,
    status_code: int | None = None,
    cost: Decimal | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    total_tokens: int | None = None,
    deployment_paid: bool = False,
) -> UsageLog:
    """A new usage row holding these values, with a fresh id and the current time."""
    return UsageLog(
        id=str(uuid.uuid4()),
        timestamp=datetime.now(UTC),
        workspace_id=workspace_id,
        api_key_id=api_key_id,
        user_id=user_id,
        model=model,
        provider=provider,
        endpoint=endpoint,
        status=status,
        latency_ms=latency_ms,
        counts_toward_budget=counts_toward_budget,
        request_group_id=request_group_id,
        error_message=error_message,
        status_code=status_code,
        cost=cost,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
        deployment_paid=deployment_paid,
    )


def settled_job_row(
    *,
    workspace_id: uuid.UUID,
    api_key_id: str | None,
    user_id: str,
    model: str,
    provider: str,
    endpoint: str,
    counts_toward_budget: bool,
    deployment_paid: bool,
    cost: Decimal | None,
    billing_meters: dict[str, int | float] | None,
    pricing_breakdown: list[ChargeLine] | None,
    pricing_source: str | None,
    pricing_reference: str | None,
    pricing_effective_at: datetime | None,
) -> UsageLog:
    """The row that settles an asynchronous job once it completes.

    No tokens and no latency: the work ran after its request returned. The row
    is priced now, so ``calculated_at`` is its timestamp where it carries a cost.
    """
    now = datetime.now(UTC)
    return UsageLog(
        id=str(uuid.uuid4()),
        timestamp=now,
        workspace_id=workspace_id,
        api_key_id=api_key_id,
        user_id=user_id,
        model=model,
        provider=provider,
        endpoint=endpoint,
        status="success",
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        counts_toward_budget=counts_toward_budget,
        deployment_paid=deployment_paid,
        cost=cost,
        calculated_at=now if cost is not None else None,
        billing_meters=billing_meters,
        pricing_breakdown=pricing_breakdown,
        pricing_source=pricing_source,
        pricing_reference=pricing_reference,
        pricing_effective_at=pricing_effective_at,
    )


@dataclass(frozen=True)
class ServedTraffic:
    """The requests this gateway served for one name sent, one offering reached and one API key.

    ``model`` is the provider's own id, or a whole selector on a row written before
    ``provider`` was recorded. ``fell_back`` counts the successful requests a
    later attempt served.
    """

    provider: str | None
    model: str
    policy_name: str | None
    api_key_id: str | None
    requests: int
    fell_back: int
    readable: bool = True
    """Whether the reader may see whose requests these are, so which key sent them."""


@dataclass(frozen=True)
class TrafficReader:
    """Whose requests a reader of routing traffic may see as someone's, and so which keys sent them.

    Every row in ``everyone_in`` (``None``: every workspace read), and elsewhere
    their own rows alone, by ``own_user_id``.
    """

    everyone_in: frozenset[uuid.UUID] | None
    own_user_id: str | None


@dataclass(frozen=True)
class NameAttempts:
    """The attempts made in one workspace for one routing name, by one key, on one target in one role, by outcome."""

    workspace_id: uuid.UUID
    name: str
    api_key_id: str | None
    provider: str | None
    model: str
    selection_reason: str | None
    """Why the plan chose the target: ``default``, ``on_failure``, ``router:<name>``, ``condition:<keys>``."""
    position: int
    """The earliest place in a plan the target was tried; a row with none recorded is the first."""
    status: str
    attempts: int


def _readable(reader: TrafficReader) -> ColumnElement[bool]:
    """Rows ``reader`` may see as someone's."""
    if reader.everyone_in is None:
        return true()
    mine = UsageLog.user_id == reader.own_user_id if reader.own_user_id is not None else false()
    return or_(UsageLog.workspace_id.in_(sorted(reader.everyone_in)), mine) if reader.everyone_in else mine


@dataclass(frozen=True)
class UsageScope:
    """The rows a read may cover, derived from the caller and never from a client filter.

    ``workspaces`` is a set of workspace ids, or a subquery selecting them, and an
    empty set covers nothing. ``None`` covers every workspace, and has to be passed:
    no read reaches every tenant's rows by leaving the scope out. ``api_key_id``
    narrows the scope to the rows one key wrote.
    """

    workspaces: Collection[uuid.UUID] | Select[uuid.UUID] | None
    api_key_id: str | None = None


@dataclass(frozen=True)
class UsageRefinements:
    """Filters that narrow a usage read past the entity filters: exclusions, routing and thresholds.

    Every exclusion on a nullable column keeps its NULL rows: ``NOT IN`` alone would
    drop them, since a NULL compares as unknown, and "not Priya's requests" does not
    mean "not requests with no billed user". An empty list is no filter.
    """

    exclude_model: list[str] | None = None
    exclude_user_id: list[str] | None = None
    exclude_api_key_id: list[str] | None = None
    exclude_source: list[str] | None = None
    exclude_status: list[str] | None = None
    policy_name: list[str] | None = None
    exclude_policy_name: list[str] | None = None
    # True: only requests a routing policy served; False: only those that named a model.
    routed: bool | None = None
    # Billed tokens (input including both cache buckets, plus output), as the log shows them.
    tokens_gt: int | None = None
    cost_gt: float | None = None
    latency_ms_gt: int | None = None
    # Only rows with one of these statuses: the subset form of ``UsageFilters.status``.
    statuses: list[str] | None = None
    # False leaves out the attempts a routing policy recovered from, unless a status
    # filter names what to keep.
    include_absorbed: bool | None = None
    # Which ways in (``UsageChannel``) a row may have come by.
    channel: list[str] | None = None
    # The columns (``NullableUsageField``) that must be empty.
    is_null: list[str] | None = None
    # Free text: a usage row id or request id exactly, or a substring of a model,
    # the name the caller sent, the source, the session label or the user id.
    q: str | None = None
    # The users whose alias and the keys whose name contain ``q``, which only the
    # domains owning those names can read; the usage service fills them in.
    q_user_ids: tuple[str, ...] = ()
    q_api_key_ids: tuple[str, ...] = ()


def search_term(q: str | None) -> str | None:
    """The term a free-text search looks for, or None when there is nothing to search."""
    term = (q or "").strip()
    return term or None


def search_request_id(term: str) -> str | None:
    """``term`` in canonical form when it is a UUID, which the search matches exactly, else None."""
    try:
        return str(uuid.UUID(term))
    except ValueError:
        return None


def is_substring_search(q: str | None) -> bool:
    """Whether ``q`` searches by substring, which no index serves, rather than looking up an id."""
    term = search_term(q)
    return term is not None and search_request_id(term) is None


@dataclass(frozen=True)
class UsageFilters:
    """What a client narrowed a usage read to. A field left ``None`` matches every row.

    ``tags`` maps each tag key to the values it may hold: values for one key match
    any of them, and different keys must all match.
    """

    start_date: datetime | None = None
    end_date: datetime | None = None
    user_id: list[str] | None = None
    status: str | None = None
    status_code: int | None = None
    model: list[str] | None = None
    endpoint: str | None = None
    provider: str | None = None
    source: str | None = None
    source_label: str | None = None
    tags: Mapping[str, list[str]] = field(default_factory=dict)
    api_key_id: list[str] | None = None
    priced: bool | None = None
    tool: str | None = None
    counts_toward_budget: bool | None = None
    request_group_id: list[str] | None = None
    workspace_id: uuid.UUID | None = None
    refine: UsageRefinements = field(default_factory=UsageRefinements)


@dataclass(frozen=True)
class RequestRows:
    """The sums over the rows one request wrote, before anything is decided from them."""

    row_count: int
    cost: Decimal | None
    priced_rows: int
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    served: int
    errors: int
    incomplete: int
    tool_cost: Decimal | None
    # Priced rows that recorded how much of their cost is tool charges.
    tool_costed_rows: int


@dataclass(frozen=True)
class KeyNameTraffic:
    """The requests one key sent under one name.

    The name is what routing recorded the request was sent as (``policy_name``,
    the routing policy or catalog ID it named) on a row served here, and
    otherwise the offering it reached, ``provider:model``. Imported usage
    reports only the model that ran. A request that named an alias reads as
    the offering the alias pointed at, since no row records the alias.
    """

    api_key_id: str
    name: str
    requests: int
    imported: int
    """Of ``requests``, those imported rather than served here."""
    routed: bool = False
    """Whether routing recorded the name, so it named a policy or a catalog ID when sent."""


@dataclass(frozen=True)
class OfferingTraffic:
    """The successful requests one provider instance served for one model id, and what they used."""

    provider: str | None
    model: str
    requests: int
    total_tokens: int
    prompt_tokens: int
    cache_read_tokens: int
    spend: float


# The columns a breakdown can group by, named by the summary's dimension vocabulary.
_GROUP_COLUMNS: dict[str, str] = {
    "model": "model",
    "user": "user_id",
    "api_key": "api_key_id",
    "source": "source",
    "source_label": "source_label",
    "endpoint": "endpoint",
    "provider": "provider",
}

# The columns a filter menu lists the values of, among those the rollups keep.
_VALUE_COLUMNS: dict[str, str] = {
    "model": "model",
    "user": "user_id",
    "api_key": "api_key_id",
    "provider": "provider",
    "status": "status",
    "source": "source",
    "source_label": "source_label",
}

# The usage columns an hour's rollups are grouped by, under the same names, so a
# condition over them reads the same against either table.
_ROLLUP_KEYS: tuple[str, ...] = (
    "workspace_id",
    "model",
    "provider",
    "endpoint",
    "user_id",
    "api_key_id",
    "source",
    "source_label",
    "status",
    "status_code",
    "counts_toward_budget",
)


def _scope_conditions(scope: UsageScope, columns: Any) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    workspaces = scope.workspaces
    if isinstance(workspaces, Select):
        conditions.append(columns.workspace_id.in_(workspaces))
    elif workspaces is not None:
        ids = sorted(workspaces)
        if not ids:
            # Belongs to no workspace yet: nothing was refused, there is simply nothing here.
            conditions.append(false())
        elif len(ids) == 1:
            conditions.append(columns.workspace_id == ids[0])
        else:
            conditions.append(columns.workspace_id.in_(ids))
    if scope.api_key_id is not None:
        conditions.append(columns.api_key_id == scope.api_key_id)
    return conditions


def _key_conditions(
    filters: UsageFilters, scope: UsageScope, columns: Any, needs_pricing: ColumnElement[bool]
) -> list[ColumnElement[bool]]:
    """The scope and every filter over a column the rollups keep, against ``usage_logs`` or ``usage_rollups``.

    ``columns`` is either table's columns, and ``needs_pricing`` says whether a row
    still needs pricing: a predicate on ``usage_logs``, a column on the rollups. A
    new filter goes here when the rollups keep its column, and in
    :func:`_row_only_conditions` otherwise.
    """
    conditions = _scope_conditions(scope, columns)
    if filters.workspace_id is not None:
        conditions.append(columns.workspace_id == filters.workspace_id)
    if filters.user_id:
        conditions.append(match_any(columns.user_id, filters.user_id))
    if filters.status is not None:
        conditions.append(columns.status == filters.status)
    if filters.status_code is not None:
        conditions.append(columns.status_code == filters.status_code)
        if filters.status is None:
            # Only a failure carries a status code (see ``UsageLog.status_code``),
            # so a bare code filter means "these failures" rather than "whatever
            # rows happen to hold this code": it stays error-scoped even if a
            # future write path starts stamping a code on a non-error row, and it
            # is served by the (status, timestamp) index instead of scanning the
            # window. An explicit ``status`` wins, so the combination stays a
            # literal query rather than a silently contradictory one.
            conditions.append(columns.status == "error")
    if filters.model:
        conditions.append(match_any(columns.model, filters.model))
    if filters.endpoint is not None:
        conditions.append(columns.endpoint == filters.endpoint)
    if filters.provider is not None:
        conditions.append(columns.provider == filters.provider)
    if filters.source is not None:
        conditions.append(columns.source == filters.source)
    if filters.source_label is not None:
        conditions.append(columns.source_label == filters.source_label)
    if filters.api_key_id:
        conditions.append(match_any(columns.api_key_id, filters.api_key_id))
    if filters.priced is True:
        conditions.append(~needs_pricing)
    elif filters.priced is False:
        conditions.append(needs_pricing)
    if filters.counts_toward_budget is not None:
        conditions.append(columns.counts_toward_budget.is_(filters.counts_toward_budget))
    refine = filters.refine
    for values, column, nullable in (
        (refine.exclude_model, columns.model, False),
        (refine.exclude_user_id, columns.user_id, True),
        (refine.exclude_api_key_id, columns.api_key_id, True),
        (refine.exclude_source, columns.source, False),
        (refine.exclude_status, columns.status, False),
    ):
        if values:
            conditions.append(_excluding(column, values, nullable=nullable))
    if refine.statuses:
        conditions.append(match_any(columns.status, refine.statuses))
    if refine.include_absorbed is False and filters.status is None and not refine.statuses:
        conditions.append(columns.status != "absorbed")
    if refine.channel:
        conditions.append(_channel_conditions(columns, refine.channel))
    for name in sorted(set(refine.is_null or [])):
        conditions.append(columns[_NULLABLE_COLUMNS[name]].is_(None))
    return conditions


def single_status(filters: UsageFilters) -> str | None:
    """The one status the rows are narrowed to, if they are, which decides what a request count counts."""
    statuses = filters.refine.statuses or []
    if filters.status is not None:
        return filters.status
    return statuses[0] if len(statuses) == 1 else None


_NULLABLE_COLUMNS: dict[str, str] = {"api_key": "api_key_id", "user": "user_id", "session": "source_label"}


def _channel_conditions(columns: Any, channels: Collection[str]) -> ColumnElement[bool]:
    """Rows that came in by one of these ways, read off the source and the endpoint, which the rollups keep."""
    served = columns.source == SERVED_HERE_SLUG
    playground = columns.endpoint == PLAYGROUND_USAGE_ENDPOINT
    by_channel: dict[str, ColumnElement[bool]] = {
        "imported": columns.source != SERVED_HERE_SLUG,
        "playground": and_(served, playground),
        "api": and_(served, columns.endpoint != PLAYGROUND_USAGE_ENDPOINT),
    }
    return or_(*(by_channel[channel] for channel in sorted(set(channels))))


def _excluding(column: Any, values: list[str], *, nullable: bool) -> ColumnElement[bool]:
    """Rows whose ``column`` holds none of ``values``; a nullable column keeps its NULL rows."""
    outside = column.not_in(values)
    return or_(column.is_(None), outside) if nullable else outside


def usage_conditions(filters: UsageFilters, scope: UsageScope) -> list[ColumnElement[bool]]:
    """Build the WHERE conditions every usage read shares.

    Keeping this in one place is what makes a paginator's total match the rows
    the list returns, and the summary's tiles match both.

    The scope is ANDed in alongside whatever the client asked for, so a client's
    ``workspace_id`` or ``api_key_id`` can only ever narrow it further.

    Bounds are pinned to UTC here rather than only where a summary resolves its
    window: an offset-less bound would otherwise resolve against the process's
    local timezone, so the same query would size a different set of rows per
    deployment.
    """
    conditions = _key_conditions(filters, scope, UsageLog.__table__.c, _needs_pricing_expr())
    if filters.start_date is not None:
        conditions.append(UsageLog.timestamp >= utc_bound(filters.start_date))
    if filters.end_date is not None:
        conditions.append(UsageLog.timestamp < utc_bound(filters.end_date))
    return [*conditions, *_row_only_conditions(filters)]


def _row_only_conditions(filters: UsageFilters) -> list[ColumnElement[bool]]:
    """The filters over what only a usage row carries. A read with any of them takes no hour from the rollups."""
    conditions = [match_any(_tag_expr(key), values) for key, values in filters.tags.items()]
    if filters.request_group_id:
        # A one-id lookup stays an equality test so it uses the index the same way
        # a single-row fetch would; the IN form is for the dashboard's batched
        # page lookup.
        conditions.append(match_any(UsageLog.request_group_id, filters.request_group_id))
    if filters.tool is not None:
        conditions.append(_tool_used_expr(filters.tool))
    refine = filters.refine
    if refine.policy_name:
        conditions.append(match_any(UsageLog.policy_name, refine.policy_name))
    if refine.exclude_policy_name:
        conditions.append(_excluding(UsageLog.policy_name, refine.exclude_policy_name, nullable=True))
    if refine.routed is not None:
        conditions.append(UsageLog.policy_name.is_not(None) if refine.routed else UsageLog.policy_name.is_(None))
    if refine.tokens_gt is not None:
        conditions.append(
            _billed_expr("total_input_tokens", UsageLog.prompt_tokens)
            + _billed_expr("completion_tokens", UsageLog.completion_tokens)
            > refine.tokens_gt
        )
    if refine.cost_gt is not None:
        conditions.append(UsageLog.cost > refine.cost_gt)
    if refine.latency_ms_gt is not None:
        conditions.append(UsageLog.latency_ms > refine.latency_ms_gt)
    if (search := _search_condition(refine)) is not None:
        conditions.append(search)
    return conditions


def _search_condition(refine: UsageRefinements) -> ColumnElement[bool] | None:
    """The rows a free-text search matches, or None when there is nothing to search for.

    A UUID is a row id, an ``Otari-Request-ID`` pasted from a log line or a user
    id, matched against those three indexed columns alone, since an OR with the
    substring arms could use none of the indexes. Anything else is a case-insensitive substring of the
    small text columns, or a user or key whose name the service found containing it.
    """
    term = search_term(refine.q)
    if term is None:
        return None
    request_id = search_request_id(term)
    if request_id is not None:
        return or_(
            UsageLog.id == request_id,
            UsageLog.request_group_id == request_id,
            UsageLog.user_id == request_id,
        )
    arms: list[ColumnElement[bool]] = [
        column.icontains(term, autoescape=True)
        for column in (
            UsageLog.model,
            UsageLog.requested_model,
            UsageLog.source,
            UsageLog.source_label,
            UsageLog.user_id,
        )
    ]
    if refine.q_user_ids:
        arms.append(UsageLog.user_id.in_(sorted(refine.q_user_ids)))
    if refine.q_api_key_ids:
        arms.append(UsageLog.api_key_id.in_(sorted(refine.q_api_key_ids)))
    return or_(*arms)


def _tag_expr(key: str) -> Any:
    """The value of tag ``key`` on a row, or null when the row does not carry it."""
    return UsageLog.tags[key].as_string()


def _request_count_expr(status_filter: str | None = None) -> Any:
    """Count requests, not rows.

    Used by every request count a usage read reports (totals, breakdowns and both
    series) so the number means one thing everywhere and the breakdowns still sum
    to the total. A row count deliberately does not use it: that one paginates the
    activity list, where an absorbed attempt is a row the operator can see and
    page through.

    A request served through a routing policy can write more than one row: the
    attempt that served it, plus one ``status="absorbed"`` row per failure the
    policy recovered from. Those extra rows describe attempts within a request that
    is already counted, so a plain ``count()`` would inflate request volume and
    deflate every rate computed against it (error rate, cost per request).

    ``status_filter`` is the caller's ``status`` filter, and ``"absorbed"`` is the
    one value that inverts the rule: every row in scope is then an excluded one, so
    the sum would report 0 requests beside non-zero cost and tokens, which reads as
    a bug rather than as a definition. Filtering *to* the attempts makes them the
    unit being asked about, so count rows.
    """
    if status_filter == "absorbed":
        return func.count()
    return func.coalesce(func.sum(case((UsageLog.status != "absorbed", 1), else_=0)), 0)


def _billed_expr(meter: str, fallback: Any) -> Any:
    """A per-row billed token meter, as a summable SQL expression.

    Providers disagree on whether cache tokens are counted inside
    ``prompt_tokens`` (see ``core/metered_pricing.billable_usage``), so raw
    column sums cannot be split into a billed composition. The pricing writers
    resolve that into ``billing_meters`` when a row is priced; prefer that, and
    fall back to the raw column under the subset convention for meterless rows,
    the same fallback the dashboard's per-row token bar applies. JSON extraction
    of a missing key and a NULL column both yield NULL, so the fallback chain
    covers both, ending at 0. ``as_integer`` compiles to the dialect's JSON
    number cast on SQLite and PostgreSQL alike.

    Cost note: ``billing_meters`` is a plain ``json`` column, so on PostgreSQL
    every extraction re-parses the row's text, and the summary runs several
    aggregate passes per render. If profiling shows this biting on large
    windows, the escapes are a ``jsonb`` migration or persisting the billed
    totals as real columns at write time; the fallback semantics here would be
    unchanged by either.
    """
    return func.coalesce(UsageLog.billing_meters[meter].as_integer(), fallback, 0)


def _needs_pricing_expr() -> ColumnElement[bool]:
    """Predicate for "this row still needs pricing".

    Two ways to qualify. Either nothing was charged at all (``cost IS NULL``, how it
    has always been expressed), or the row carries a cost that came *only* from
    gateway-run tool calls while its tokens were never metered. The second case
    exists because a request against an unpriced model can still owe for the searches
    it ran, and charging it a tool cost would otherwise hide it from the exact view an
    operator uses to find what needs a rate.

    The tool-namespace test keeps this narrow on purpose: a row with a cost and no
    meters at all is a row priced before the meter columns existed, and it must keep
    reading as priced.
    """
    token_metered = UsageLog.billing_meters["total_input_tokens"].as_integer().is_not(None)
    tool_charged = UsageLog.billing_meters[TOOL_METER_NAMESPACE].as_string().is_not(None)
    return or_(UsageLog.cost.is_(None), and_(tool_charged, ~token_metered))


def _tool_calls_expr(tool: str) -> Any:
    """Billable call count for one gateway-run tool on a row, or NULL."""
    return UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "billed")].as_integer()


def _tool_cost_expr(tool: str) -> Any:
    """USD charged for one tool on a row, read off its own charge line.

    The row's ``cost`` mixes tokens and tools, so per-tool spend has to come from
    the line ``price_tool_calls`` wrote. ``pricing_breakdown`` is a JSON *array*,
    and the tool lines are appended after the token ones, so the position is not
    fixed; the units and the rate are both on the line, so the product is
    reconstructed from the meter count instead, which needs no array search.
    """
    return _tool_calls_expr(tool) * _tool_unit_rate_expr(tool)


def _tool_unit_rate_expr(tool: str) -> Any:
    """Per-call USD rate recorded on the row for one tool.

    Stored per row rather than looked up live, so a historical row keeps the rate
    it was actually billed at even after the operator changes the price.
    """
    return func.coalesce(
        UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "unit_rate")].as_float(),
        0.0,
    )


def _tool_used_expr(tool: str) -> ColumnElement[bool]:
    """Predicate for "this request ran a gateway tool".

    ``any`` tests the namespace itself so an MCP tool (whose name is supplied by the
    caller's server and cannot be enumerated here) still matches. A specific name
    indexes into the namespace. Both compile to the dialect's JSON extraction on
    SQLite and PostgreSQL; neither is indexable, which is acceptable because every
    activity query is already bounded by the indexed timestamp window.
    """
    if tool == ANY_TOOL:
        # ``.as_string()`` is load-bearing: an uncoerced JSON index compares with JSON
        # semantics, where SQL NULL and JSON null are not the same thing, and
        # ``IS NOT NULL`` then matches every row. Coercing to text makes a missing key
        # read as SQL NULL on both SQLite and PostgreSQL.
        namespace = UsageLog.billing_meters[TOOL_METER_NAMESPACE].as_string()
        return cast("ColumnElement[bool]", namespace.is_not(None))
    return cast("ColumnElement[bool]", _tool_calls_expr(tool).is_not(None))


# The billed composition aggregates shared by the summary series, the grand
# totals, and the grouped series, so all three reconcile by construction.
def _billed_input_sum() -> Any:
    return func.coalesce(func.sum(_billed_expr("total_input_tokens", UsageLog.prompt_tokens)), 0)


def _billed_output_sum() -> Any:
    return func.coalesce(func.sum(_billed_expr("completion_tokens", UsageLog.completion_tokens)), 0)


# Past this many marked hours in a window, a read takes the whole window from the
# rows: the rollups are still being built (as after the migration that adds them)
# or a bulk change marked much of the history, and the rows then read in one pass.
MAX_MARKED_HOURS = 48

_HOUR = timedelta(hours=1)
# Any fixed number serves; it only has to be the rollup refresh's alone.
_REFRESH_LOCK = 0x7573_6167_6572_6F6C

# The tool spend measures sum as ``numeric``, so an hour's sums add up to what the
# rows do; a sum of floats depends on the order its terms arrive in.
_EXACT = Numeric(asdecimal=False)


def _row_measures() -> dict[str, Any]:
    """What one usage row contributes to each measure a usage read sums, by measure name.

    The refresh sums these into an hour's rollups and a read projects them from the
    rows, so the two cannot disagree on what a measure means.
    """
    measures: dict[str, Any] = {
        "cost": UsageLog.cost,
        "prompt_tokens": UsageLog.prompt_tokens,
        "completion_tokens": UsageLog.completion_tokens,
        "total_tokens": UsageLog.total_tokens,
        "cache_read_tokens": UsageLog.cache_read_tokens,
        "cache_write_tokens": UsageLog.cache_write_tokens,
        "cache_write_1h_tokens": UsageLog.cache_write_1h_tokens,
        "reasoning_tokens": UsageLog.reasoning_tokens,
        "billed_input_tokens": _billed_expr("total_input_tokens", UsageLog.prompt_tokens),
        "billed_output_tokens": _billed_expr("completion_tokens", UsageLog.completion_tokens),
        "billed_cache_read_tokens": _billed_expr("cache_read_tokens", UsageLog.cache_read_tokens),
        "billed_cache_write_tokens": _billed_expr("cache_write_tokens", UsageLog.cache_write_tokens),
        "latency_ms": UsageLog.latency_ms,
        "latency_count": case((UsageLog.latency_ms.is_not(None), 1), else_=0),
    }
    for tool in GATEWAY_TOOL_NAMES:
        calls = _tool_calls_expr(tool)
        ran = calls.is_not(None)
        measures[f"{tool}_calls"] = calls
        # Counted only where the row billed calls of the tool, as the tool table reads them.
        measures[f"{tool}_errors"] = case(
            (ran, UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "errors")].as_integer())
        )
        measures[f"{tool}_cost"] = sql_cast(_tool_cost_expr(tool), _EXACT)
        measures[f"{tool}_rows"] = case((ran, 1), else_=0)
    return measures


_MEASURES: tuple[str, ...] = tuple(_row_measures())


def _raw_rows(conditions: Sequence[ColumnElement[bool]]) -> Select[Any]:
    """The usage rows the conditions leave, each standing for itself, in the usage relation's columns."""
    measures = _row_measures()
    table = UsageLog.__table__.c
    return select(
        *(table[key].label(key) for key in _ROLLUP_KEYS),
        _needs_pricing_expr().label("needs_pricing"),
        UsageLog.timestamp.label("ts"),
        literal(1, BigInteger).label("rows"),
        *(measures[name].label(name) for name in _MEASURES),
    ).where(*conditions)


def _summed_rows(conditions: Sequence[ColumnElement[bool]]) -> Select[Any]:
    """The rollups the conditions leave, in :func:`_raw_rows`'s columns and order."""
    rollup = UsageRollup.__table__.c
    return select(
        *(rollup[key] for key in _ROLLUP_KEYS),
        rollup.needs_pricing,
        rollup.hour.label("ts"),
        rollup.rows,
        *(rollup[name] for name in _MEASURES),
    ).where(*conditions)


def _hour_of(timestamp: Any) -> Any:
    """The UTC hour a timestamp falls in, as a ``timestamptz``, the way the triggers mark it."""
    return func.timezone("UTC", func.date_trunc("hour", func.timezone("UTC", timestamp)))


def _floor_hour(moment: datetime) -> datetime:
    """The UTC hour ``moment`` falls in. In UTC because an offset of half an hour has its own hours."""
    return cast("datetime", utc_bound(moment)).astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def _ceil_hour(moment: datetime) -> datetime:
    floor = _floor_hour(moment)
    return floor if floor == utc_bound(moment) else floor + _HOUR


def _spans(hours: Collection[datetime]) -> list[tuple[datetime, datetime]]:
    """Hours as the fewest ``[start, end)`` spans that cover them."""
    spans: list[tuple[datetime, datetime]] = []
    for hour in sorted(hours):
        if spans and spans[-1][1] == hour:
            spans[-1] = (spans[-1][0], hour + _HOUR)
        else:
            spans.append((hour, hour + _HOUR))
    return spans


def _in_spans(column: Any, spans: Sequence[tuple[datetime, datetime]]) -> list[ColumnElement[bool]]:
    return [and_(column >= start, column < end) for start, end in spans]


def _no_extra(_columns: Any) -> list[ColumnElement[bool]]:
    return []


def _requests(rows: Subquery, status_filter: str | None = None) -> Any:
    """The requests the usage relation's rows stand for; see :func:`_request_count_expr`."""
    if status_filter == "absorbed":
        return func.coalesce(func.sum(rows.c.rows), 0)
    return func.coalesce(func.sum(case((rows.c.status != "absorbed", rows.c.rows), else_=0)), 0)


def _summed(column: Any, zero: Any = 0) -> Any:
    return func.coalesce(func.sum(column), zero)


@dataclass(frozen=True)
class UsageSortLabels:
    """How the user and source orders name a row, from the domains that own the names.

    Each takes ``usage_logs``' own id column and returns the name it points at as a
    scalar subquery: a user's alias, an API key's name.
    """

    user: Callable[[Any], Any]
    api_key: Callable[[Any], Any]


def _ordering(sort: UsageSort, order: SortOrder, labels: UsageSortLabels | None) -> tuple[Any, ...]:
    """ORDER BY for a page: the chosen key with empty values last, then newest first, then the id.

    The id closes the ordering so rows tied on every other key keep one order
    across pages; without it, OFFSET paging could repeat or skip a row.
    """
    if sort == "timestamp":
        # Not nulls_last(): the column is never NULL, and NULLS LAST would stop
        # PostgreSQL scanning the timestamp index backwards.
        if order == "asc":
            return UsageLog.timestamp.asc(), UsageLog.id.asc()
        return UsageLog.timestamp.desc(), UsageLog.id.desc()
    user_name: Any = labels.user(UsageLog.user_id) if labels is not None else None
    key_name: Any = labels.api_key(UsageLog.api_key_id) if labels is not None else None
    keys: dict[str, Any] = {
        "user": func.lower(func.coalesce(user_name, UsageLog.user_id)),
        "model": func.lower(UsageLog.model),
        "policy": func.lower(UsageLog.policy_name),
        # The API key's name, or the provenance source where no key made the row.
        "source": func.lower(func.coalesce(key_name, UsageLog.source)),
        "input_tokens": _billed_expr("total_input_tokens", UsageLog.prompt_tokens),
        "output_tokens": _billed_expr("completion_tokens", UsageLog.completion_tokens),
        "tokens": _billed_expr("total_input_tokens", UsageLog.prompt_tokens)
        + _billed_expr("completion_tokens", UsageLog.completion_tokens),
        "cost": UsageLog.cost,
        "latency": UsageLog.latency_ms,
        # A request served on a later attempt had an earlier one fail, so it ranks
        # with the recovered attempts, between the failures and the clean successes.
        "status": case(
            (UsageLog.status == "error", 3),
            (UsageLog.status == "incomplete", 2),
            (or_(UsageLog.status == "absorbed", UsageLog.attempt_position > 1), 1),
            else_=0,
        ),
    }
    key = keys[sort]
    primary = (key.asc() if order == "asc" else key.desc()).nulls_last()
    return primary, UsageLog.timestamp.desc(), UsageLog.id.desc()


class UsageLogRepository(BaseRepository[UsageLog, Never, Never]):
    """Read usage rows inside a set of workspaces, and keep their hourly rollups.

    The aggregate reads sum one relation in a row's shape (:func:`_raw_rows`),
    where a relation row stands for ``rows`` usage rows. On PostgreSQL that is a
    whole hour's sums from ``usage_rollups`` wherever they are current, and the
    rows themselves for the rest of the window: its partial edge hours, which take
    the current hour's writes as they land, and any hour a write marked since its
    sums were built. A read whose filters name what the rollups do not keep (a
    tag, a request id, a tool) takes the whole window from the rows, and so does
    every read on SQLite, where nothing marks the hours a write changed. A routing
    policy or a threshold is one of those filters too.
    ``rollups=False`` reads the rows everywhere.
    """

    def __init__(self, uow: UnitOfWork, *, rollups: bool = True) -> None:
        super().__init__(uow, UsageLog)
        self._rollups = rollups

    async def add(self, row: UsageLog) -> None:
        """Stage ``row`` in the open block, so it commits with the step that settled it."""
        self.db.add(row)
        await self.db.flush()

    async def reassign_owner(self, user_ids: Collection[str], to_user_id: str) -> None:
        """Stage moving these users' rows onto ``to_user_id``, without the fields that could name a person.

        The caller's tags, the session label, the provider-facing end-user
        identifier and the upstream error text are cleared; the counts and costs stay.
        """
        if not user_ids:
            return
        await self.db.execute(
            update(UsageLog)
            .where(UsageLog.user_id.in_(list(user_ids)))
            .values(user_id=to_user_id, tags=None, source_label=None, safety_identifier=None, error_message=None)
            .execution_options(synchronize_session=False)
        )

    async def add_many(self, rows: list[UsageLog]) -> None:
        """Stage usage rows together in the current transaction."""
        if not rows:
            return
        self.db.add_all(rows)
        await self.db.flush()

    async def delete_imported_before(self, cutoff: datetime, *, limit: int) -> int:
        """Delete up to ``limit`` imported rows older than ``cutoff``, returning how many went.

        Imported means this deployment did not serve the request and it never
        counted toward a budget, so a row the gateway served, budget-exempt
        traffic included, is never matched.
        """
        expired = (
            select(UsageLog.id)
            .where(
                UsageLog.timestamp < cutoff,
                UsageLog.source != SERVED_HERE_SLUG,
                UsageLog.counts_toward_budget.is_(False),
            )
            .limit(limit)
        )
        result = cast("CursorResult[Any]", await self.db.execute(delete(UsageLog).where(UsageLog.id.in_(expired))))
        return result.rowcount or 0

    async def served_traffic(
        self,
        *,
        workspace_ids: Collection[uuid.UUID],
        since: datetime,
        reader: TrafficReader | None = None,
        api_key_ids: Collection[str] | None = None,
    ) -> list[ServedTraffic]:
        """The requests served here since ``since`` in these workspaces, by name sent, offering reached and key.

        One grouped read. Imported usage is left out, because it was never served
        here. With a ``reader``, each group says whether that reader may see whose
        requests they are, and ``api_key_ids`` narrows to those keys' rows among
        the ones the reader may see so.
        """
        if not workspace_ids:
            return []
        readable = _readable(reader) if reader is not None else true()
        readable_flag = case((readable, True), else_=False)
        fell_back = func.sum(case((and_(UsageLog.status == "success", UsageLog.attempt_position > 1), 1), else_=0))
        stmt = (
            select(
                UsageLog.provider,
                UsageLog.model,
                UsageLog.policy_name,
                UsageLog.api_key_id,
                readable_flag.label("readable"),
                func.count().label("requests"),
                func.coalesce(fell_back, 0).label("fell_back"),
            )
            .where(
                UsageLog.workspace_id.in_(sorted(workspace_ids)),
                UsageLog.source == SERVED_HERE_SLUG,
                UsageLog.status.in_(_REQUEST_STATUSES),
                UsageLog.timestamp >= since,
            )
            .group_by(UsageLog.provider, UsageLog.model, UsageLog.policy_name, UsageLog.api_key_id, readable_flag)
        )
        if api_key_ids is not None:
            stmt = stmt.where(UsageLog.api_key_id.in_(sorted(api_key_ids)), readable)
        return [
            ServedTraffic(
                provider=row.provider,
                model=row.model,
                policy_name=row.policy_name,
                api_key_id=row.api_key_id,
                requests=int(row.requests),
                fell_back=int(row.fell_back),
                readable=bool(row.readable),
            )
            for row in (await self.db.execute(stmt)).all()
        ]

    async def name_attempts(
        self,
        *,
        workspace_ids: Collection[uuid.UUID],
        names: Collection[str],
        since: datetime,
        reader: TrafficReader,
        api_key_ids: Collection[str] | None = None,
    ) -> list[NameAttempts]:
        """The attempts made since ``since`` under these routing names, by workspace, key, target, role and outcome.

        Only rows ``reader`` may see as someone's, narrowed to ``api_key_ids`` when
        given. A row with no step recorded is the first step. Imported usage is
        left out.
        """
        if not workspace_ids or not names:
            return []
        position = func.min(func.coalesce(UsageLog.attempt_position, 1))
        stmt = (
            select(
                UsageLog.workspace_id,
                UsageLog.policy_name,
                UsageLog.api_key_id,
                UsageLog.provider,
                UsageLog.model,
                UsageLog.selection_reason,
                position.label("position"),
                UsageLog.status,
                func.count().label("attempts"),
            )
            .where(
                UsageLog.workspace_id.in_(sorted(workspace_ids)),
                UsageLog.policy_name.in_(sorted(names)),
                UsageLog.source == SERVED_HERE_SLUG,
                UsageLog.status.in_((*_REQUEST_STATUSES, "absorbed")),
                UsageLog.timestamp >= since,
                _readable(reader),
            )
            .group_by(
                UsageLog.workspace_id,
                UsageLog.policy_name,
                UsageLog.api_key_id,
                UsageLog.provider,
                UsageLog.model,
                UsageLog.selection_reason,
                UsageLog.status,
            )
        )
        if api_key_ids is not None:
            stmt = stmt.where(UsageLog.api_key_id.in_(sorted(api_key_ids)))
        return [
            NameAttempts(
                workspace_id=row.workspace_id,
                name=row.policy_name,
                api_key_id=row.api_key_id,
                provider=row.provider,
                model=row.model,
                selection_reason=row.selection_reason,
                position=int(row.position),
                status=row.status,
                attempts=int(row.attempts),
            )
            for row in (await self.db.execute(stmt)).all()
        ]

    async def names_by_key(
        self, key_ids: Collection[str], *, workspace_ids: Collection[uuid.UUID], since: datetime
    ) -> list[KeyNameTraffic]:
        """Requests per key and name sent since ``since``, for these keys in these workspaces, most first.

        Each request counts once, on the row that ended it: an attempt a later
        one recovered from is ``absorbed`` and left out.
        """
        if not key_ids or not workspace_ids:
            return []
        imported = UsageLog.source != SERVED_HERE_SLUG
        reached = case((UsageLog.provider.is_not(None), UsageLog.provider + ":" + UsageLog.model), else_=UsageLog.model)
        name = case((imported, UsageLog.model), else_=func.coalesce(UsageLog.policy_name, reached))
        requests = func.count()
        stmt = (
            select(
                UsageLog.api_key_id,
                name.label("name"),
                requests.label("requests"),
                func.sum(case((imported, 1), else_=0)).label("imported"),
                func.max(case((and_(~imported, UsageLog.policy_name.is_not(None)), 1), else_=0)).label("routed"),
            )
            .where(
                UsageLog.api_key_id.in_(sorted(key_ids)),
                UsageLog.workspace_id.in_(sorted(workspace_ids)),
                UsageLog.status.in_(_REQUEST_STATUSES),
                UsageLog.timestamp >= since,
            )
            .group_by(UsageLog.api_key_id, name)
            .order_by(UsageLog.api_key_id, requests.desc(), name)
        )
        return [
            KeyNameTraffic(
                api_key_id=row.api_key_id,
                name=row.name,
                requests=int(row.requests),
                imported=int(row.imported),
                routed=bool(row.routed),
            )
            for row in (await self.db.execute(stmt)).all()
        ]

    async def page(
        self,
        filters: UsageFilters,
        scope: UsageScope,
        *,
        skip: int,
        limit: int,
        sort: UsageSort = "timestamp",
        order: SortOrder = "desc",
        labels: UsageSortLabels | None = None,
    ) -> list[UsageLog]:
        """The rows matching these filters inside this scope, in the order asked for, newest first by default."""
        stmt = (
            select(UsageLog)
            .where(*usage_conditions(filters, scope))
            .order_by(*_ordering(sort, order, labels))
            .offset(skip)
            .limit(limit)
        )
        return list((await self.db.execute(stmt)).scalars().all())

    async def p95_latency_ms(self, filters: UsageFilters, scope: UsageScope) -> int | None:
        """The 95th-percentile total latency over the matching requests, absorbed attempts left out.

        Read from the rows, since an hour's rollups keep only a latency sum.
        PostgreSQL interpolates with ``percentile_cont``; SQLite has no ordered-set
        aggregate, so there the two latencies either side of the same position are
        read by rank and interpolated the same way, and both engines agree.
        """
        measured = [
            *usage_conditions(filters, scope),
            UsageLog.status != "absorbed",
            UsageLog.latency_ms.is_not(None),
        ]
        if dialect_name(self.db) == "postgresql":
            value = (
                await self.db.execute(
                    select(func.percentile_cont(0.95).within_group(UsageLog.latency_ms.asc())).where(*measured)
                )
            ).scalar_one_or_none()
            return round(float(value)) if value is not None else None
        count = int((await self.db.execute(select(func.count()).select_from(UsageLog).where(*measured))).scalar_one())
        if not count:
            return None
        position = 0.95 * (count - 1)
        lower = int(position)
        ranked = (
            await self.db.execute(
                select(UsageLog.latency_ms).where(*measured).order_by(UsageLog.latency_ms.asc()).offset(lower).limit(2)
            )
        ).scalars()
        values = [int(value) for value in ranked if value is not None]
        if len(values) == 1:
            return values[0]
        return round(values[0] + (values[1] - values[0]) * (position - lower))

    async def count_matching(self, filters: UsageFilters, scope: UsageScope, *, imported_only: bool = False) -> int:
        """How many rows match these filters inside this scope; with ``imported_only``, only rows not served here."""

        def imported(columns: Any) -> list[ColumnElement[bool]]:
            return [columns.source != SERVED_HERE_SLUG] if imported_only else []

        rows = await self._usage_rows(filters, scope, imported)
        return int((await self.db.execute(select(_summed(rows.c.rows)))).scalar_one())

    async def request_rows(self, request_id: str, *, api_key_id: str | None) -> RequestRows:
        """The sums over the rows one request wrote, confined to one key's rows when ``api_key_id`` is set."""
        conditions: list[ColumnElement[bool]] = [UsageLog.request_group_id == request_id]
        if api_key_id is not None:
            conditions.append(UsageLog.api_key_id == api_key_id)
        stmt = select(
            func.count(),
            func.sum(UsageLog.cost),
            func.count(UsageLog.cost),
            func.coalesce(func.sum(UsageLog.prompt_tokens), 0),
            func.coalesce(func.sum(UsageLog.completion_tokens), 0),
            func.coalesce(func.sum(UsageLog.total_tokens), 0),
            # A vision describe side-call's success row is written before the main
            # call runs and is the only one with no latency, so it settles nothing.
            func.count(case(((UsageLog.status == "success") & UsageLog.latency_ms.is_not(None), 1))),
            func.count(case((UsageLog.status == "error", 1))),
            func.count(case((UsageLog.status == "incomplete", 1))),
            func.sum(UsageLog.tool_cost),
            func.count(case((UsageLog.cost.is_not(None) & UsageLog.tool_cost.is_not(None), 1))),
        ).where(*conditions)
        row = (await self.db.execute(stmt)).one()
        return RequestRows(
            row_count=int(row[0]),
            cost=row[1],
            priced_rows=int(row[2]),
            prompt_tokens=int(row[3] or 0),
            completion_tokens=int(row[4] or 0),
            total_tokens=int(row[5] or 0),
            served=int(row[6]),
            errors=int(row[7]),
            incomplete=int(row[8]),
            tool_cost=row[9],
            tool_costed_rows=int(row[10]),
        )

    async def cost_and_requests(self, filters: UsageFilters, scope: UsageScope) -> tuple[float, int]:
        """The spend and the request count over the matching rows."""
        rows = await self._usage_rows(filters, scope)
        stmt = select(_summed(rows.c.cost, 0.0), _requests(rows, single_status(filters)))
        cost, requests = (await self.db.execute(stmt)).one()
        return float(cost), int(requests)

    async def totals(self, filters: UsageFilters, scope: UsageScope) -> UsageTotals:
        """Grand totals over the matching rows."""
        rows = await self._usage_rows(filters, scope)
        c = rows.c
        # Averaged over requests, not attempts: an absorbed row carries the time
        # spent on a candidate that did not serve, and folding it in would make a
        # policy that recovers quickly look slower than one that never fails.
        served = c.status != "absorbed"
        # The quotient ``avg`` would compute: ``numeric`` on PostgreSQL, a float on
        # SQLite, where dividing two integers truncates.
        ratio_type: Numeric[Any] | Float[Any] = Numeric() if dialect_name(self.db) == "postgresql" else Float()
        latency = sql_cast(func.sum(case((served, c.latency_ms))), ratio_type) / func.nullif(
            sql_cast(func.sum(case((served, c.latency_count))), ratio_type), 0
        )
        row = (
            await self.db.execute(
                select(
                    _summed(c.cost, 0.0),
                    _summed(c.prompt_tokens),
                    _summed(c.completion_tokens),
                    _summed(c.total_tokens),
                    _summed(c.cache_read_tokens),
                    _summed(c.cache_write_tokens),
                    _summed(c.cache_write_1h_tokens),
                    _requests(rows, single_status(filters)),
                    _summed(case((c.status == "error", c.rows), else_=0)),
                    latency,
                    # Unpriced *served* rows only; see UsageTotals.unpriced_requests. The
                    # predicate is shared with the list filter so the tile and the rows it
                    # sends an operator to agree.
                    _summed(case(((c.status == "success") & c.needs_pricing, c.rows), else_=0)),
                    _summed(c.billed_input_tokens),
                    _summed(c.billed_output_tokens),
                    _summed(c.reasoning_tokens),
                    _summed(case((c.status == "absorbed", c.rows), else_=0)),
                    _summed(case((c.status == "incomplete", c.rows), else_=0)),
                    _summed(case((c.source != SERVED_HERE_SLUG, c.cost), else_=0), 0.0),
                )
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
            reasoning_tokens=int(row[13]),
            absorbed_count=int(row[14]),
            incomplete_count=int(row[15]),
            imported_cost=float(row[16]),
        )

    async def groups(
        self,
        filters: UsageFilters,
        scope: UsageScope,
        *,
        dimension: str | None = None,
        tag_key: str | None = None,
        limit: int | None,
    ) -> list[UsageGroupRow]:
        """Spend, billed tokens and requests grouped by a dimension or by one tag's values, biggest spend first.

        ``tokens`` is the *billed* total (input including both cache buckets, plus
        output), the same quantity both series report, so every analytics surface
        agrees on what a token count means. Equal spend ranks by key, so the cap
        cuts the same groups wherever the sums came from.
        """
        if tag_key is not None:
            return await self._tag_groups(filters, scope, tag_key=tag_key, limit=limit)
        rows = await self._usage_rows(filters, scope)
        column = rows.c[_GROUP_COLUMNS[cast("str", dimension)]]
        cost_sum = _summed(rows.c.cost, 0.0)
        stmt = (
            select(
                column,
                cost_sum,
                _summed(rows.c.billed_input_tokens) + _summed(rows.c.billed_output_tokens),
                _requests(rows, single_status(filters)),
            )
            .group_by(column)
            .order_by(cost_sum.desc(), column)
        )
        if limit is not None:
            stmt = stmt.limit(limit)
        return [
            UsageGroupRow(key=row[0], cost=float(row[1]), tokens=int(row[2]), requests=int(row[3]))
            for row in (await self.db.execute(stmt)).all()
        ]

    async def value_groups(
        self,
        filters: UsageFilters,
        scope: UsageScope,
        *,
        group_by: ValueGroupBy,
        search: str | None,
        named: Collection[str],
        skip: int,
        limit: int,
    ) -> tuple[list[UsageValueGroup], int]:
        """A page of one column's values over the matching rows, busiest first, and how many values there are.

        ``search`` keeps the values that contain it (case-insensitive, ``%`` and
        ``_`` literal), and also those in ``named``: the keys whose label matched,
        which only the domain that owns the label can say. Equal counts rank by
        key, so a page cuts the same values wherever the sums came from. The
        policy a request was served through is kept only on the rows, so that
        column reads them.
        """
        relation: Subquery | None = None
        where: list[ColumnElement[bool]] = []
        if group_by == "policy":
            column: Any = UsageLog.policy_name
            requests: Any = _request_count_expr(single_status(filters))
            errors: Any = func.coalesce(func.sum(case((UsageLog.status == "error", 1), else_=0)), 0)
            cost: Any = func.coalesce(func.sum(UsageLog.cost), 0.0)
            where = usage_conditions(filters, scope)
        else:
            relation = await self._usage_rows(filters, scope)
            column = relation.c[_VALUE_COLUMNS[group_by]]
            # By status every row is its own value, the absorbed attempts included.
            requests = _summed(relation.c.rows) if group_by == "status" else _requests(relation, single_status(filters))
            errors = _summed(case((relation.c.status == "error", relation.c.rows), else_=0))
            cost = _summed(relation.c.cost, 0.0)
        term = (search or "").strip()
        if term:
            matched = [column.icontains(term, autoescape=True)]
            if named:
                matched.append(column.in_(sorted(named)))
            where.append(or_(*matched))
        # The total rides on the page as a window count, so the rows are aggregated once.
        stmt = select(column, requests, errors, cost, func.count().over()).where(*where).group_by(column)
        if relation is not None:
            stmt = stmt.select_from(relation)
        page = (await self.db.execute(stmt.order_by(requests.desc(), column).offset(skip).limit(limit))).all()
        if page:
            total = int(page[0][4])
        elif skip:
            # Past the last page there is no row to carry the count.
            grouped = select(column).where(*where).group_by(column)
            if relation is not None:
                grouped = grouped.select_from(relation)
            total = int((await self.db.execute(select(func.count()).select_from(grouped.subquery()))).scalar_one())
        else:
            total = 0
        return [
            UsageValueGroup(key=row[0], requests=int(row[1]), errors=int(row[2]), cost=float(row[3])) for row in page
        ], total

    async def _tag_groups(
        self, filters: UsageFilters, scope: UsageScope, *, tag_key: str, limit: int | None
    ) -> list[UsageGroupRow]:
        """:meth:`groups` by one tag's values, which only the rows carry."""
        column = _tag_expr(tag_key)
        cost_sum = func.coalesce(func.sum(UsageLog.cost), 0.0)
        stmt = (
            select(
                column,
                cost_sum,
                _billed_input_sum() + _billed_output_sum(),
                _request_count_expr(single_status(filters)),
            )
            .where(*usage_conditions(filters, scope))
            .group_by(column)
            .order_by(cost_sum.desc())
        )
        if limit is not None:
            stmt = stmt.limit(limit)
        return [
            UsageGroupRow(key=row[0], cost=float(row[1]), tokens=int(row[2]), requests=int(row[3]))
            for row in (await self.db.execute(stmt)).all()
        ]

    async def tool_usage(self, filters: UsageFilters, scope: UsageScope) -> list[UsageToolRow]:
        """Per-tool calls, failures, spend and requests over the matching rows, biggest spend first.

        One set of aggregates per known tool rather than a ``GROUP BY`` over the
        meter map: a JSON map's keys cannot be grouped portably across SQLite and
        PostgreSQL, and the set of gateway-run tools is small and fixed. Cost comes
        from each row's charge line rather than the row total, because a row's
        ``cost`` also carries tokens.

        ``calls`` and ``errors`` count every call a request made, including calls made by
        an attempt a routing policy later abandoned: the tally is shared across a
        request's attempts and settled onto the row that served, so those calls are on
        that one row rather than spread across the absorbed ones. ``requests`` counts
        requests, so the two answer different questions on purpose: "how much tool work
        did we do" and "how many requests used a tool".
        """
        rows = await self._usage_rows(filters, scope)
        c = rows.c
        # Requests, not rows: a request that failed over through a routing policy
        # writes an absorbed row per recovered attempt, and counting those would
        # report more requests using a tool than the Activity list shows for the
        # same filter.
        served = c.status != "absorbed"
        stmt = select(
            *(
                aggregate
                for tool in GATEWAY_TOOL_NAMES
                for aggregate in (
                    _summed(c[f"{tool}_calls"]),
                    _summed(c[f"{tool}_errors"]),
                    _summed(case((served, c[f"{tool}_rows"]), else_=0)),
                    _summed(c[f"{tool}_cost"], 0.0),
                )
            )
        )
        row = (await self.db.execute(stmt)).one()
        out: list[UsageToolRow] = []
        for index, tool in enumerate(GATEWAY_TOOL_NAMES):
            calls, errors, requests, cost = row[index * 4 : index * 4 + 4]
            if not calls and not errors:
                continue
            out.append(
                UsageToolRow(tool=tool, calls=int(calls), errors=int(errors), requests=int(requests), cost=float(cost))
            )
        return sorted(out, key=lambda r: r.cost, reverse=True)

    async def errors_by_status_code(
        self, filters: UsageFilters, scope: UsageScope, *, limit: int
    ) -> list[tuple[int | None, int]]:
        """Failures among the matching rows by status code, most frequent first, as ``(status_code, requests)``.

        Equal counts rank by code, so the cap cuts the same codes wherever the sums came from.
        """

        def failures(columns: Any) -> list[ColumnElement[bool]]:
            return [columns.status == "error"]

        rows = await self._usage_rows(filters, scope, failures)
        request_count = _summed(rows.c.rows)
        result = (
            await self.db.execute(
                select(rows.c.status_code, request_count)
                .group_by(rows.c.status_code)
                .order_by(request_count.desc(), rows.c.status_code)
                .limit(limit)
            )
        ).all()
        return [(row[0], int(row[1])) for row in result]

    async def series(self, filters: UsageFilters, scope: UsageScope, *, bucket: Bucket) -> list[UsageSeriesPoint]:
        """The populated time buckets of the matching rows."""
        rows = await self._usage_rows(filters, scope)
        c = rows.c
        expr = bucket_expr(dialect_name(self.db), bucket, c.ts)
        result = (
            await self.db.execute(
                select(
                    expr,
                    _summed(c.cost, 0.0),
                    _summed(c.total_tokens),
                    _requests(rows, single_status(filters)),
                    _summed(case((c.status == "error", c.rows), else_=0)),
                    _summed(c.billed_input_tokens),
                    _summed(c.billed_cache_read_tokens),
                    _summed(c.billed_cache_write_tokens),
                    _summed(c.billed_output_tokens),
                ).group_by(expr)
            )
        ).all()
        return [
            UsageSeriesPoint(
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
            for row in result
        ]

    async def grouped_series(
        self,
        filters: UsageFilters,
        scope: UsageScope,
        *,
        bucket: Bucket,
        dimension: str,
        named: Collection[str],
        keeps_null: bool,
    ) -> list[UsageGroupedSeriesPoint]:
        """The populated (time bucket, group) cells of the matching rows, groups outside ``named`` folded into one.

        One grouped query for the whole grid: groups outside the named ones
        collapse into the fold in SQL rather than being fetched and folded by the
        caller, so the row count stays bounded by buckets × (named + 2) regardless
        of cardinality. The synthesized groups are encoded as (key NULL, fold
        flag) rather than a sentinel key string: GROUP BY treats NULLs as equal on
        both dialects, and no sentinel can be trusted never to collide with a real
        key. A NULL column value never matches ``IN``, so it lands in the CASE's
        ``else`` arm; with ``keeps_null`` the fold flag then separates a NULL group
        that ranked among the named ones (a real ``key=None`` series, e.g. a
        deleted user) from the remainder.
        """
        rows = await self._usage_rows(filters, scope)
        column = rows.c[_GROUP_COLUMNS[dimension]]
        key_expr = case((column.in_(named), column), else_=null())
        if keeps_null:
            fold_expr = case((column.is_(None), 0), (column.in_(named), 0), else_=1)
        else:
            fold_expr = case((column.in_(named), 0), else_=1)
        expr = bucket_expr(dialect_name(self.db), bucket, rows.c.ts)
        result = (
            await self.db.execute(
                select(
                    expr,
                    key_expr,
                    fold_expr,
                    _summed(rows.c.cost, 0.0),
                    _summed(rows.c.billed_input_tokens) + _summed(rows.c.billed_output_tokens),
                    _requests(rows, single_status(filters)),
                ).group_by(expr, key_expr, fold_expr)
            )
        ).all()
        return [
            UsageGroupedSeriesPoint(
                bucket_start=canonical_bucket(row[0], bucket),
                key=row[1],
                is_other=bool(row[2]),
                cost=float(row[3]),
                tokens=int(row[4]),
                requests=int(row[5]),
            )
            for row in result
        ]

    async def offering_traffic(
        self, scope: UsageScope, *, since: datetime, offerings: Collection[tuple[str, str, str]]
    ) -> list[OfferingTraffic]:
        """The successful requests since ``since`` against these offerings, by provider and model.

        Each offering is ``(selector, instance, model id)``. A usage row carries the
        instance and the provider's model id separately, and older rows carry the
        whole selector in ``model``, so both spellings match and both come back as
        groups of their own.
        """
        if not offerings:
            return []

        def matching(columns: Any) -> list[ColumnElement[bool]]:
            return [
                or_(
                    *(
                        ((columns.provider == instance) & (columns.model == model_id)) | (columns.model == selector)
                        for selector, instance, model_id in offerings
                    )
                )
            ]

        rows = await self._usage_rows(UsageFilters(start_date=since, status="success"), scope, matching)
        c = rows.c
        stmt = select(
            c.provider,
            c.model,
            _summed(c.rows),
            _summed(c.total_tokens),
            _summed(c.prompt_tokens),
            _summed(c.cache_read_tokens),
            _summed(c.cost),
        ).group_by(c.provider, c.model)
        return [
            OfferingTraffic(
                provider=row[0],
                model=row[1],
                requests=int(row[2]),
                total_tokens=int(row[3]),
                prompt_tokens=int(row[4]),
                cache_read_tokens=int(row[5]),
                spend=float(row[6]),
            )
            for row in (await self.db.execute(stmt)).all()
        ]

    async def _usage_rows(
        self,
        filters: UsageFilters,
        scope: UsageScope,
        extra: Callable[[Any], list[ColumnElement[bool]]] = _no_extra,
    ) -> Subquery:
        """The rows these filters leave inside this scope, as the usage relation, rollups wherever they serve.

        ``extra`` adds conditions over the keys the rollups keep, given either
        table's columns.
        """
        conditions = [*usage_conditions(filters, scope), *extra(UsageLog.__table__.c)]
        window = await self._rollup_window(filters)
        if window is None:
            return _raw_rows(conditions).subquery("usage_rows")
        whole_start, whole_end, marked = window
        rollup = UsageRollup.__table__.c
        summed = [*_key_conditions(filters, scope, rollup, rollup.needs_pricing), *extra(rollup)]
        from_rows = _in_spans(UsageLog.timestamp, marked)
        if whole_start is not None:
            summed.append(rollup.hour >= whole_start)
            from_rows.append(UsageLog.timestamp < whole_start)
        if whole_end is not None:
            summed.append(rollup.hour < whole_end)
            from_rows.append(UsageLog.timestamp >= whole_end)
        if marked:
            summed.append(~or_(*_in_spans(rollup.hour, marked)))
        return union_all(
            _summed_rows(summed), _raw_rows([*conditions, or_(*from_rows) if from_rows else false()])
        ).subquery("usage_rows")

    async def _rollup_window(
        self, filters: UsageFilters
    ) -> tuple[datetime | None, datetime | None, list[tuple[datetime, datetime]]] | None:
        """The whole hours the rollups serve and the marked spans inside them, or None to read only the rows.

        A missing bound leaves that side open: the rollups then serve every hour
        on it that no write has marked.
        """
        if not self._rollups or _row_only_conditions(filters) or dialect_name(self.db) != "postgresql":
            return None
        whole_start = _ceil_hour(filters.start_date) if filters.start_date is not None else None
        whole_end = _floor_hour(filters.end_date) if filters.end_date is not None else None
        if whole_start is not None and whole_end is not None and whole_start >= whole_end:
            return None
        dirty = UsageRollupDirtyHour.__table__.c
        stmt = select(dirty.hour).distinct()
        if whole_start is not None:
            stmt = stmt.where(dirty.hour >= whole_start)
        if whole_end is not None:
            stmt = stmt.where(dirty.hour < whole_end)
        marked = list((await self.db.execute(stmt.limit(MAX_MARKED_HOURS + 1))).scalars())
        if len(marked) > MAX_MARKED_HOURS:
            return None
        return whole_start, whole_end, _spans(marked)

    async def refresh_rollups(self, max_hours: int, *, now: datetime) -> int:
        """Rebuild up to ``max_hours`` of the latest marked hours before ``now``'s, and return how many.

        Latest first, so after the rollups first appear the weeks a dashboard reads
        are built before the history. The hour ``now`` falls in is left marked: a
        window that ends now reads it from its rows as a partial hour anyway, and
        it is built once it is over.

        One refresh at a time, under a transaction-scoped advisory lock, and a
        refresh that finds it taken builds nothing: two building the same hour would
        each delete the sums the other has not committed yet and both insert theirs.
        The marks are taken before the rows are read, so a write that commits in
        between leaves its mark for the next refresh, which builds the hour again.
        PostgreSQL only; elsewhere nothing marks an hour.
        """
        if dialect_name(self.db) != "postgresql":
            return 0
        if not (await self.db.execute(select(func.pg_try_advisory_xact_lock(_REFRESH_LOCK)))).scalar_one():
            return 0
        dirty = UsageRollupDirtyHour.__table__.c
        latest = (
            select(dirty.hour)
            .where(dirty.hour < _floor_hour(now))
            .distinct()
            .order_by(dirty.hour.desc())
            .limit(max_hours)
            .scalar_subquery()
        )
        taken = await self.db.execute(delete(UsageRollupDirtyHour).where(dirty.hour.in_(latest)).returning(dirty.hour))
        hours = set(taken.scalars())
        if not hours:
            return 0
        rollup = UsageRollup.__table__.c
        await self.db.execute(delete(UsageRollup).where(rollup.hour.in_(sorted(hours))))
        measures = _row_measures()
        table = UsageLog.__table__.c
        keys = [table[key] for key in _ROLLUP_KEYS]
        needs_pricing = _needs_pricing_expr()
        hour = _hour_of(UsageLog.timestamp)
        summed = (
            select(
                *keys,
                needs_pricing,
                hour,
                func.count(),
                *(func.sum(measures[name]) for name in _MEASURES),
            )
            .where(or_(*_in_spans(UsageLog.timestamp, _spans(hours))))
            .group_by(*keys, needs_pricing, hour)
        )
        await self.db.execute(
            insert(UsageRollup).from_select([*_ROLLUP_KEYS, "needs_pricing", "hour", "rows", *_MEASURES], summed)
        )
        return len(hours)

    async def marked_hours(self) -> int:
        """How many distinct hours wait for the rollup refresh."""
        dirty = UsageRollupDirtyHour.__table__.c
        return int((await self.db.execute(select(func.count(func.distinct(dirty.hour))))).scalar_one())
