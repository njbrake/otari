"""Response models of the usage log's reads: the summary, the grouped series and the activity groups."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from gateway.core.sql import UsageBucketGrain, utc_bound

# The columns the activity log can be collapsed on.
ActivityGroupBy = Literal["api_key", "source_label", "model", "user", "policy", "alias"]
# Most recently active first, or busiest first.
ActivityGroupOrder = Literal["recent", "requests"]

# The grid the grouped series and the agent-telemetry series share with the telemetry
# port; only the summary's own series also takes five minutes.
Bucket = Literal["hour", "day"]
SeriesGroupBy = Literal["model", "user_id", "api_key_id", "source"]

# The columns a summary breakdown groups by. A dimension name is the ``by_<name>``
# response field it fills, so a caller reads the selector and the payload with
# one vocabulary.
BreakdownDimension = Literal["model", "user", "api_key", "source", "source_label", "endpoint", "provider"]

# Every breakdown ``/summary`` can compute: the columns above, the failure taxonomy
# (``status_code``), and the tool spend. The extra ``none`` is the explicit empty
# selection (a repeated query param cannot express an empty list on the wire).
SummaryDimension = Literal[
    "model", "user", "api_key", "source", "source_label", "endpoint", "provider", "status_code", "tool", "none"
]

# Coarse display buckets for a failure's status code. A closed Literal rather than
# a bare str so the set lands in the OpenAPI schema as an enum and a consumer can
# switch on it exhaustively instead of string-matching whatever the server sent.
ErrorClass = Literal["pricing", "rate_limit", "auth", "provider_error", "client_error", "unknown"]


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
    # excluded by design (their names are unbounded, see ``GATEWAY_TOOL_NAMES``).
    by_tool: list[UsageToolRow] = []
    # Failures only, so the taxonomy is not swamped by the successes that carry
    # no status code. Counts sum to ``totals.error_count``, unless a window
    # somehow held more than the breakdown cap's distinct codes, in which case
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


class UsageActivityGroup(BaseModel):
    """One group of the activity log: every request sharing a key, session, model, user, policy or alias.

    ``key`` is None for the rows that have no value in the grouped column (no
    key, no session, no billed user); filter to them with ``is_null``, or for
    policy, ``routed=false``. Token counts are billed quantities (see
    ``billed_meter``), and ``latency_ms`` is the summed total latency of the
    requests counted, the model time the group took.
    """

    # Built from the read repository's group rows by attribute.
    model_config = ConfigDict(from_attributes=True)

    key: str | None
    label: str | None = None
    requests: int
    errors: int
    absorbed: int
    # Every row's cost, imported usage's included. ``imported_cost`` is the part
    # from rows this deployment did not serve, so the gateway's own spend is
    # ``cost - imported_cost``, as on the summary's totals.
    cost: float
    imported_cost: float
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    latency_ms: int
    first_at: str
    last_at: str
    # The group's most-used models, most requests first, and how many distinct
    # models its rows name in all, an absorbed attempt's included.
    models: list[str]
    model_count: int

    @field_validator("first_at", "last_at", mode="before")
    @classmethod
    def _utc_iso(cls, value: object) -> object:
        return utc_bound(value).isoformat() if isinstance(value, datetime) else value


class UsageActivityGroups(BaseModel):
    """A page of activity groups in the order asked for, and how many there are."""

    start_date: str
    end_date: str
    group_by: ActivityGroupBy
    groups: list[UsageActivityGroup]
    total: int
