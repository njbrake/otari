"""Usage-row filter conditions that the read endpoints and the bulk mutations share.

The same reason ``core/sql.py`` exists, one step more specific: these conditions
name ORM columns, so they cannot live in that dialect-level module, and they must be
built once, because a bulk delete re-derives its target set from the filters an
operator was shown. A search the list honored and the delete read differently would
delete rows no count ever promised.
"""

import uuid
from collections.abc import Sequence
from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, Field
from sqlalchemy import ColumnElement, case, func, or_, select

from gateway.core.sql import MAX_FILTER_VALUES, match_any
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User

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
    session label, key name or alias that is itself a UUID is not searched this way;
    none is written in that form. Everything else is a
    case-insensitive substring of the served model, the name the caller sent (so an
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
MAX_NULLABLE_FIELDS = len(get_args(NullableUsageField))


class UsageRefinements(BaseModel):
    """Filters that narrow the usage rows past the entity filters every endpoint takes.

    One model for two readers: the read endpoints build it from query parameters
    (``routes/usage._usage_refinements``) and the bulk mutation body inherits it, so
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
    is_null: NullableUsageField | Annotated[list[NullableUsageField], Field(max_length=MAX_NULLABLE_FIELDS)] | None = (
        None
    )
    # The token and latency columns are 32-bit, so a larger threshold is refused
    # here rather than overflowing the parameter in the database.
    tokens_gt: int | None = Field(default=None, ge=0, le=MAX_INT32)
    cost_gt: float | None = Field(default=None, ge=0)
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
    conditions.extend(_NULLABLE[field].is_(None) for field in _as_list(refine.is_null or []))
    if refine.tokens_gt is not None:
        conditions.append(billed_tokens() > refine.tokens_gt)
    if refine.cost_gt is not None:
        conditions.append(UsageLog.cost > refine.cost_gt)
    if refine.latency_ms_gt is not None:
        conditions.append(UsageLog.latency_ms > refine.latency_ms_gt)
    return conditions
