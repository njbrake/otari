"""Usage-row filter conditions that the read endpoints and the bulk mutations share.

The same reason ``core/sql.py`` exists, one step more specific: these conditions
name ORM columns, so they cannot live in that dialect-level module, and they must be
built once, because a bulk delete re-derives its target set from the filters an
operator was shown. A search the list honored and the delete read differently would
delete rows no count ever promised.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal, NamedTuple, Protocol, cast, get_args

from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, Select, Subquery, and_, case, func, or_, select

from gateway.core.sql import MAX_FILTER_VALUES, match_any, utc_bound
from gateway.models.api_keys import APIKey
from gateway.models.money import MAX_USD_LIMIT
from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT, SERVED_HERE_SLUG, UsageLog
from gateway.models.users import User

# One WHERE condition over ``usage_logs``, as the reads pass them through the usage service.
UsageCondition = ColumnElement[bool]

# The way a request reached the usage log: usage imported through the external-events
# ingest (rows this deployment did not serve), a message typed in the dashboard's
# Playground, or a call to the API from somebody's own code.
UsageChannel = Literal["imported", "playground", "api"]


def minted_key(api_key_id: Any) -> ColumnElement[bool]:
    """Match rows made under a key this deployment minted for itself (its ``internal_secret`` is set).

    A set test rather than a lookup per row, so the planner reads the few minted
    keys once. False, never NULL, for a row with no key, so its negation keeps that row.
    """
    minted = select(APIKey.id).where(APIKey.internal_secret.is_not(None))
    return and_(api_key_id.is_not(None), api_key_id.in_(minted))


def playground_traffic(endpoint: Any, minted: ColumnElement[bool]) -> ColumnElement[bool]:
    """Match rows the dashboard's own Playground made, under either of its two shapes.

    Where this deployment runs the completion itself, the row carries
    ``PLAYGROUND_USAGE_ENDPOINT``. Where a hosted control plane forwards to its
    data-plane gateway, the row is labeled like every other usage report and only
    the credential tells it apart: ``minted`` says the row's key carries an
    ``internal_secret``, however the caller reaches it (a join where the query
    groups by it, :func:`minted_key` where it filters).
    """
    return or_(endpoint == PLAYGROUND_USAGE_ENDPOINT, minted)


def usage_channel(source: Any, endpoint: Any, minted: ColumnElement[bool]) -> ColumnElement[str]:
    """Which :data:`UsageChannel` a row came in by, the one rule the breakdown and the filter share.

    ``minted`` is as :func:`playground_traffic` takes it.
    """
    imported: UsageChannel = "imported"
    playground: UsageChannel = "playground"
    api: UsageChannel = "api"
    return case(
        (source != SERVED_HERE_SLUG, imported),
        (playground_traffic(endpoint, minted), playground),
        else_=api,
    )


# The key ``UsageLog.billing_meters`` nests every tool meter under. Tool meters sit
# under one reserved key rather than flat beside the token meters: MCP tool names
# come from a caller-supplied server, and a tool named ``completion_tokens`` sitting
# flat would be read by the billed-token SQL here and corrupt every aggregate over it.
TOOL_METER_NAMESPACE = "tools"
# The tool filter value that matches any tool, an MCP one included.
ANY_TOOL = "any"

# Longest search a caller may send. Far past a request id or a model name; it keeps a
# caller from posting a megabyte pattern into a LIKE over the window searched.
MAX_SEARCH_LENGTH = 200


def is_substring_search(q: str | None) -> bool:
    """Whether ``q`` searches by substring, which no index serves, rather than looking up an id.

    The split :func:`usage_search_condition` makes: a UUID is an exact lookup on
    two indexed columns, anything else a ``LIKE`` over several.
    """
    term = (q or "").strip()
    if not term:
        return False
    try:
        uuid.UUID(term)
    except ValueError:
        return True
    return False


def usage_search_condition(q: str) -> ColumnElement[bool] | None:
    """Rows a free-text search matches, or None when there is nothing to search for.

    A UUID is an ``Otari-Request-ID`` or a row id pasted from a log line, so it is
    matched, in canonical form, against those two columns alone, which keeps the
    lookup on their indexes (an OR with the substring arms below could use none). A
    session label, key name or alias that is itself a UUID is therefore not matched
    by ``q``; the ``source_label`` filter finds a UUID-shaped session label. Everything
    else is a case-insensitive substring of the served model, the name the caller sent (so an
    alias finds its rows), the session label, the API key's name or the billed user's
    alias. The two names live on other tables and are matched through
    ``IN (subquery)`` so the condition fits any statement over ``usage_logs`` (a
    count, a summary, a delete) without it carrying the joins. ``autoescape`` makes
    ``%`` and ``_`` literal.
    """
    term = q.strip()
    if not term:
        return None
    try:
        canonical = str(uuid.UUID(term))
    except ValueError:
        pass
    else:
        return or_(UsageLog.request_id == canonical, UsageLog.id == canonical)
    return or_(
        UsageLog.model.icontains(term, autoescape=True),
        UsageLog.requested_model.icontains(term, autoescape=True),
        UsageLog.source_label.icontains(term, autoescape=True),
        UsageLog.api_key_id.in_(select(APIKey.id).where(APIKey.key_name.icontains(term, autoescape=True))),
        UsageLog.user_id.in_(select(User.user_id).where(User.alias.icontains(term, autoescape=True))),
    )


def billed_meter(meter: str, fallback: Any) -> Any:
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
    """
    return func.coalesce(UsageLog.billing_meters[meter].as_integer(), fallback, 0)


def needs_pricing_condition() -> ColumnElement[bool]:
    """Rows that still need pricing.

    Two ways to qualify. Either nothing was charged at all (``cost IS NULL``), or
    the row carries a cost that came *only* from gateway-run tool calls while its
    tokens were never metered: a request against an unpriced model can still owe
    for the searches it ran, and that tool cost would otherwise hide it from the
    view an operator uses to find what needs a rate.

    The tool-namespace test keeps this narrow on purpose: a row with a cost and no
    meters at all is a row priced before the meter columns existed, and it must keep
    reading as priced.
    """
    token_metered = UsageLog.billing_meters["total_input_tokens"].as_integer().is_not(None)
    tool_charged = UsageLog.billing_meters[TOOL_METER_NAMESPACE].as_string().is_not(None)
    return or_(UsageLog.cost.is_(None), and_(tool_charged, ~token_metered))


def tool_calls_expr(tool: str) -> Any:
    """Billable call count for one gateway-run tool on a row, or NULL."""
    return UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "billed")].as_integer()


def tag_expr(key: str) -> Any:
    """The value of request tag ``key`` on a row, or null when the row does not carry it."""
    return UsageLog.tags[key].as_string()


def tag_conditions(tags: dict[str, list[str]]) -> list[ColumnElement[bool]]:
    """One condition per tag key: values for one key match any of them, and different keys must all match."""
    return [match_any(tag_expr(key), values) for key, values in tags.items()]


def tool_used_condition(tool: str) -> ColumnElement[bool]:
    """Rows of requests that ran this gateway tool, or any tool for :data:`ANY_TOOL`.

    ``any`` tests the namespace itself so an MCP tool (whose name is supplied by the
    caller's server and cannot be enumerated) still matches. Neither form is
    indexable, which is acceptable because every activity query is already bounded
    by the indexed timestamp window.
    """
    if tool == ANY_TOOL:
        # ``.as_string()`` is load-bearing: an uncoerced JSON index compares with JSON
        # semantics, where SQL NULL and JSON null are not the same thing, and
        # ``IS NOT NULL`` then matches every row. Coercing to text makes a missing key
        # read as SQL NULL on both SQLite and PostgreSQL.
        namespace = UsageLog.billing_meters[TOOL_METER_NAMESPACE].as_string()
        return cast("ColumnElement[bool]", namespace.is_not(None))
    return cast("ColumnElement[bool]", tool_calls_expr(tool).is_not(None))


def billed_tokens() -> Any:
    """A row's billed token total: input including both cache buckets, plus output.

    The number the Activity row's token bar shows, so a threshold or a sort on
    tokens orders rows by what the reader sees.
    """
    return billed_meter("total_input_tokens", UsageLog.prompt_tokens) + billed_meter(
        "completion_tokens", UsageLog.completion_tokens
    )


def request_count(status_filter: str | None = None) -> Any:
    """Count requests, not rows.

    Used by every "request count" the usage reads report (totals, dimension
    breakdowns, the grouped series and the activity groups) so the number means one
    thing everywhere and the breakdowns still sum to the total. The row-count
    endpoint (`/api/v1/usage/count`) deliberately does not use it: that one
    paginates the activity list, where an absorbed attempt is a row the operator
    can see and page through.

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


def billed_input_sum() -> Any:
    """The billed input tokens of the rows in scope, cache buckets included."""
    return func.coalesce(func.sum(billed_meter("total_input_tokens", UsageLog.prompt_tokens)), 0)


def billed_output_sum() -> Any:
    """The billed output tokens of the rows in scope."""
    return func.coalesce(func.sum(billed_meter("completion_tokens", UsageLog.completion_tokens)), 0)


def billed_cache_read_sum() -> Any:
    """The billed cache-read tokens of the rows in scope.

    Not the raw ``cache_read_tokens`` column sum the summary totals report beside the
    other raw provider counts; this is the meter the billed composition is built from.
    """
    return func.coalesce(func.sum(billed_meter("cache_read_tokens", UsageLog.cache_read_tokens)), 0)


def billed_cache_write_sum() -> Any:
    """The billed cache-write tokens of the rows in scope."""
    return func.coalesce(func.sum(billed_meter("cache_write_tokens", UsageLog.cache_write_tokens)), 0)


def status_count(status: str) -> Any:
    """How many rows in scope have this status: rows, not requests (see :func:`request_count`)."""
    return func.coalesce(func.sum(case((UsageLog.status == status, 1), else_=0)), 0)


def billed_cost_sum() -> Any:
    """The cost of the rows in scope this deployment served: what it billed, imported usage left out."""
    return func.coalesce(func.sum(case((UsageLog.source == SERVED_HERE_SLUG, UsageLog.cost), else_=0)), 0.0)


def imported_cost_sum() -> Any:
    """The cost of the rows in scope this deployment did not serve: imported usage, never charged to a budget."""
    return func.coalesce(func.sum(case((UsageLog.source != SERVED_HERE_SLUG, UsageLog.cost), else_=0)), 0.0)


# The orders a page of usage rows can be read in, and which way.
UsageSort = Literal["timestamp", "tokens", "cost", "latency", "model", "source", "member", "policy", "status"]
SortOrder = Literal["asc", "desc"]


# A repeatable filter's values, bounded the way the read endpoints bound theirs (see
# MAX_FILTER_VALUES). The bound is annotated on the list itself rather than on a
# ``str | list[str]`` field: on the union it would also cap a single value's
# character length, rejecting a long provider-qualified model name.
CappedValues = Annotated[list[str], Field(max_length=MAX_FILTER_VALUES)]
UsageStatus = Literal["success", "error", "absorbed"]
# The grouped columns a group's rows can have no value in: what expanding the group
# of rows with no key, no session or no billed user filters by.
NullableUsageField = Literal["api_key_id", "user_id", "source_label"]
_NULLABLE: dict[str, Any] = {
    "api_key_id": UsageLog.api_key_id,
    "user_id": UsageLog.user_id,
    "source_label": UsageLog.source_label,
}
MAX_STATUSES = len(get_args(UsageStatus))
MAX_INT32 = 2**31 - 1
# The largest cost threshold a filter takes. The cost column's own ceiling rounds up
# to a float the column cannot hold, so this is the bound a budget limit takes.
MAX_COST_THRESHOLD = MAX_USD_LIMIT
MAX_NULLABLE_FIELDS = len(get_args(NullableUsageField))


# Every channel there is, the most a channel filter can name.
MAX_CHANNELS = len(get_args(UsageChannel))


class UsageRefinements(BaseModel):
    """Filters that narrow the usage rows past the entity filters every endpoint takes.

    One model for two readers: the read endpoints build it from query parameters
    (``routes/_usage_common.usage_refinements``) and the bulk mutation body inherits it, so
    a delete by filter re-derives exactly the rows the operator was shown.

    Every exclusion on a nullable column keeps its NULL rows: ``NOT IN`` alone
    would drop them, since a NULL compares as unknown, and "not Priya's requests"
    does not mean "not requests with no billed user".
    """

    # One value or several, as the entity filters take them.
    exclude_model: str | CappedValues | None = None
    exclude_user_id: str | CappedValues | None = None
    exclude_api_key_id: str | CappedValues | None = None
    exclude_source: str | CappedValues | None = None
    exclude_status: UsageStatus | Annotated[list[UsageStatus], Field(max_length=MAX_STATUSES)] | None = None
    policy_name: str | CappedValues | None = None
    exclude_policy_name: str | CappedValues | None = None
    # True: only requests a routing policy served; False: only requests that named
    # a model or an alias directly.
    routed: bool | None = None
    channel: UsageChannel | Annotated[list[UsageChannel], Field(max_length=MAX_CHANNELS)] | None = None
    exclude_channel: UsageChannel | Annotated[list[UsageChannel], Field(max_length=MAX_CHANNELS)] | None = None
    is_null: NullableUsageField | Annotated[list[NullableUsageField], Field(max_length=MAX_NULLABLE_FIELDS)] | None = (
        None
    )
    # The token and latency columns are 32-bit, so a larger threshold is refused
    # here rather than overflowing the parameter in the database; a cost past the
    # cost column's range, or not finite, cannot be bound to it.
    tokens_gt: int | None = Field(default=None, ge=0, le=MAX_INT32)
    cost_gt: float | None = Field(default=None, ge=0, le=MAX_COST_THRESHOLD, allow_inf_nan=False)
    latency_ms_gt: int | None = Field(default=None, ge=0, le=MAX_INT32)


def _as_list[T: str](value: T | Sequence[T]) -> list[T]:
    return [value] if isinstance(value, str) else list(value)


def _excluding(column: Any, values: str | Sequence[str], *, nullable: bool) -> ColumnElement[bool]:
    outside = column.not_in(_as_list(values))
    return or_(column.is_(None), outside) if nullable else outside


def refinement_conditions(refine: UsageRefinements) -> list[ColumnElement[bool]]:
    """The WHERE conditions a set of refinements adds. Empty lists are no filter."""
    conditions: list[ColumnElement[bool]] = []
    if refine.exclude_model:
        conditions.append(_excluding(UsageLog.model, refine.exclude_model, nullable=False))
    if refine.exclude_user_id:
        conditions.append(_excluding(UsageLog.user_id, refine.exclude_user_id, nullable=True))
    if refine.exclude_api_key_id:
        conditions.append(_excluding(UsageLog.api_key_id, refine.exclude_api_key_id, nullable=True))
    if refine.exclude_source:
        conditions.append(_excluding(UsageLog.source, refine.exclude_source, nullable=False))
    if refine.exclude_status:
        conditions.append(_excluding(UsageLog.status, refine.exclude_status, nullable=False))
    if refine.policy_name:
        conditions.append(match_any(UsageLog.policy_name, refine.policy_name))
    if refine.exclude_policy_name:
        conditions.append(_excluding(UsageLog.policy_name, refine.exclude_policy_name, nullable=True))
    if refine.routed is not None:
        conditions.append(UsageLog.policy_name.is_not(None) if refine.routed else UsageLog.policy_name.is_(None))
    if refine.channel or refine.exclude_channel:
        channel = usage_channel(UsageLog.source, UsageLog.endpoint, minted_key(UsageLog.api_key_id))
        if refine.channel:
            conditions.append(channel.in_(_as_list(refine.channel)))
        if refine.exclude_channel:
            conditions.append(channel.not_in(_as_list(refine.exclude_channel)))
    conditions.extend(_NULLABLE[field].is_(None) for field in _as_list(refine.is_null or []))
    if refine.tokens_gt is not None:
        conditions.append(billed_tokens() > refine.tokens_gt)
    if refine.cost_gt is not None:
        conditions.append(UsageLog.cost > refine.cost_gt)
    if refine.latency_ms_gt is not None:
        conditions.append(UsageLog.latency_ms > refine.latency_ms_gt)
    return conditions


class UsageEntityFilters(Protocol):
    """The filters the usage reads and the bulk selection both take, read by :func:`entity_conditions`."""

    @property
    def workspace_id(self) -> uuid.UUID | None: ...
    @property
    def user_id(self) -> str | list[str] | None: ...
    @property
    def status(self) -> str | None: ...
    @property
    def model(self) -> str | list[str] | None: ...
    @property
    def endpoint(self) -> str | None: ...
    @property
    def provider(self) -> str | None: ...
    @property
    def source(self) -> str | None: ...
    @property
    def source_label(self) -> str | None: ...
    @property
    def api_key_id(self) -> str | list[str] | None: ...
    @property
    def priced(self) -> bool | None: ...
    @property
    def tool(self) -> str | None: ...
    @property
    def requested_model(self) -> str | list[str] | None: ...
    @property
    def q(self) -> str | None: ...


def entity_conditions(
    filters: UsageEntityFilters,
    *,
    start_date: datetime | None,
    end_date: datetime | None,
) -> list[ColumnElement[bool]]:
    """The WHERE conditions of the filters a read and a bulk selection share, over a resolved window.

    One builder for both, because a bulk mutation re-derives its rows from the
    filters the operator was shown counted: a filter the two read differently would
    delete or reprice rows no count promised. An empty list is no filter, and bounds
    are pinned to UTC (see :func:`~gateway.core.sql.utc_bound`).
    """
    conditions: list[ColumnElement[bool]] = []
    if filters.workspace_id is not None:
        conditions.append(UsageLog.workspace_id == filters.workspace_id)
    if start_date is not None:
        conditions.append(UsageLog.timestamp >= utc_bound(start_date))
    if end_date is not None:
        conditions.append(UsageLog.timestamp < utc_bound(end_date))
    if filters.user_id is not None and filters.user_id != []:
        conditions.append(match_any(UsageLog.user_id, filters.user_id))
    if filters.status is not None:
        conditions.append(UsageLog.status == filters.status)
    if filters.model is not None and filters.model != []:
        conditions.append(match_any(UsageLog.model, filters.model))
    if filters.endpoint is not None:
        conditions.append(UsageLog.endpoint == filters.endpoint)
    if filters.provider is not None:
        conditions.append(UsageLog.provider == filters.provider)
    if filters.source is not None:
        conditions.append(UsageLog.source == filters.source)
    if filters.source_label is not None:
        conditions.append(UsageLog.source_label == filters.source_label)
    if filters.api_key_id is not None and filters.api_key_id != []:
        conditions.append(match_any(UsageLog.api_key_id, filters.api_key_id))
    if filters.priced is True:
        conditions.append(~needs_pricing_condition())
    elif filters.priced is False:
        conditions.append(needs_pricing_condition())
    if filters.tool is not None:
        conditions.append(tool_used_condition(filters.tool))
    if filters.requested_model is not None and filters.requested_model != []:
        conditions.append(match_any(UsageLog.requested_model, filters.requested_model))
    if filters.q is not None and (search := usage_search_condition(filters.q)) is not None:
        conditions.append(search)
    return conditions


class LabelJoin(NamedTuple):
    """How to resolve a breakdown key's display name in the same GROUP BY.

    Only the dimensions whose key is an opaque id need this: a model, source or
    endpoint already reads as its own name. Resolving it here is what lets a
    client offer a user or key filter without holding those whole tables.
    """

    entity: Any
    on: Any
    label: Any


def user_label(user_id: Any) -> LabelJoin:
    """Name the billed user ``user_id`` holds, in the same GROUP BY as the usage rows."""
    return LabelJoin(entity=User, on=User.user_id == user_id, label=User.alias)


def api_key_label(api_key_id: Any) -> LabelJoin:
    """Name the API key ``api_key_id`` holds, in the same GROUP BY as the usage rows."""
    return LabelJoin(entity=APIKey, on=APIKey.id == api_key_id, label=APIKey.key_name)


USER_LABEL = user_label(UsageLog.user_id)
API_KEY_LABEL = api_key_label(UsageLog.api_key_id)

# The row's API key, aliased so it never collides with the key label join, for the
# credential half of the Playground rule. The channel breakdown groups by the channel,
# so it reads the key through this join, where the channel filter only tests rows and
# uses the set test ``minted_key``; only the channel breakdown, and the series split
# by channel, join it.
CHANNEL_KEY = APIKey.__table__.alias("row_key")

# Which way a request reached the log, read through ``CHANNEL_KEY``.
CHANNEL = usage_channel(UsageLog.source, UsageLog.endpoint, CHANNEL_KEY.c.internal_secret.is_not(None))


# The aggregate reads are range-bounded, unlike the raw list. Absent a start_date
# they look back this far; a wider explicit window is clamped to the hard cap so a
# single request can never turn into an unbounded full-table scan on a growing log.
DEFAULT_SUMMARY_LOOKBACK = timedelta(days=30)
MAX_SUMMARY_SPAN = timedelta(days=366)


def resolve_window(start_date: datetime | None, end_date: datetime | None) -> tuple[datetime, datetime]:
    """Clamp the requested window to a bounded, forward-ordered range.

    A summary must never scan an unbounded log: absent a start we look back
    ``DEFAULT_SUMMARY_LOOKBACK``; a span wider than ``MAX_SUMMARY_SPAN`` has its
    start pulled forward so the aggregates stay bounded by the timestamp index.

    An offset-less ISO datetime (which the query params advertise as valid) parses
    to a naive value; ``now(UTC)`` is aware. Comparing or subtracting the two would
    raise, so naive bounds are assumed UTC and made aware first.
    """
    if start_date is not None and start_date.tzinfo is None:
        start_date = start_date.replace(tzinfo=UTC)
    if end_date is not None and end_date.tzinfo is None:
        end_date = end_date.replace(tzinfo=UTC)
    end = end_date or datetime.now(UTC)
    start = start_date if start_date is not None else end - DEFAULT_SUMMARY_LOOKBACK
    if start > end:
        start = end
    if end - start > MAX_SUMMARY_SPAN:
        start = end - MAX_SUMMARY_SPAN
    return start, end


def list_window(
    start_date: datetime | None,
    end_date: datetime | None,
    *,
    q: str | None,
    sort: UsageSort = "timestamp",
) -> tuple[datetime | None, datetime | None]:
    """The window a list, its count and a bulk selection by filter read.

    As asked, unless the read would otherwise visit every row in the log: a
    substring search, which no index serves, or any order but newest first, which
    sorts every row before it can return one. Those read the window ``/summary``
    does. The count applies the same bound as the list, so a paginator's total is
    the total of the pages.
    """
    if sort == "timestamp" and not is_substring_search(q):
        return start_date, end_date
    return resolve_window(start_date, end_date)


def window_rows(
    start: datetime,
    end: datetime,
    workspaces: Any,
    *,
    user_id: str | None = None,
    api_key_ids: Any = None,
) -> list[UsageCondition]:
    """Usage rows in ``[start, end)`` of ``workspaces`` (one id, or a select of ids), narrowed to one user or some keys.

    For readers outside the usage domain that aggregate usage beside their own
    tables, such as the overview's rails: they compose these pieces rather than
    query ``usage_logs`` themselves.
    """
    in_workspaces = (
        UsageLog.workspace_id == workspaces
        if isinstance(workspaces, uuid.UUID)
        else UsageLog.workspace_id.in_(workspaces)
    )
    where = [UsageLog.timestamp >= start, UsageLog.timestamp < end, in_workspaces]
    if user_id is not None:
        where.append(UsageLog.user_id == user_id)
    if api_key_ids is not None:
        where.append(UsageLog.api_key_id.in_(api_key_ids))
    return where


def spend_by_key(conditions: Sequence[UsageCondition]) -> Subquery:
    """Each key's billed spend over ``conditions``, with its row count and how many rows were served here."""
    return (
        select(
            UsageLog.api_key_id.label("key_id"),
            billed_cost_sum().label("billed"),
            func.count().label("rows"),
            func.coalesce(func.sum(case((UsageLog.source == SERVED_HERE_SLUG, 1), else_=0)), 0).label("served"),
        )
        .where(*conditions, UsageLog.api_key_id.is_not(None))
        .group_by(UsageLog.api_key_id)
        .subquery()
    )


def spend_by_workspace(conditions: Sequence[UsageCondition]) -> Subquery:
    """Each workspace's billed spend over ``conditions``, with its requests, failures and last request."""
    return (
        select(
            UsageLog.workspace_id.label("workspace_id"),
            billed_cost_sum().label("billed"),
            request_count().label("requests"),
            status_count("error").label("failures"),
            func.max(UsageLog.timestamp).label("last_used_at"),
        )
        .where(*conditions)
        .group_by(UsageLog.workspace_id)
        .subquery()
    )


def requests_and_failures(conditions: Sequence[UsageCondition]) -> Select[tuple[int, int]]:
    """Requests and failures over ``conditions``, counted as every usage read counts them."""
    return select(request_count(), status_count("error")).where(*conditions)
