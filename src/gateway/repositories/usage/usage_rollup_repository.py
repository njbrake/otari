"""The usage rows a summary aggregates: an hour's sums from ``usage_rollups`` where they are current, else the rows.

A read over a window asks :meth:`UsageRollupRepository.rows` for one relation
with a row's shape: each key column a usage filter or breakdown reads, the
timestamp (``ts``), and the measures, with ``rows`` saying how many usage rows
a relation row stands for. Every measure is one row's value, so an aggregate is
a sum of it however many rows each relation row stands for, and the same SQL
answers from the rollups and from the rows.

What a row contributes is defined once, in :func:`_row_values`: the refresh sums
it into an hour's rollups and a read projects it from the rows themselves, so
the two cannot disagree on what a measure means.

A read takes an hour from the rollups only when all of these hold, and from the
rows otherwise: the database is PostgreSQL (only there does the trigger mark the
hours a write changed), the series is bucketed by hour or coarser, every
condition names only key columns (a search by request id, a tag, a cost threshold
or a tool do not), the hour lies wholly inside the window, and no write has marked
it since its sums were built.
"""

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Never

from sqlalchemy import (
    BigInteger,
    BinaryExpression,
    Column,
    ColumnElement,
    Integer,
    Select,
    Subquery,
    and_,
    case,
    cast,
    delete,
    func,
    insert,
    literal,
    or_,
    select,
    union_all,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql import operators
from sqlalchemy.sql.visitors import iterate, replacement_traverse

from gateway.core.sql import UsageBucketGrain, dialect_name, utc_bound
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import TOOL_METER_NAMESPACE, billed_meter, needs_pricing_condition, tool_calls_expr
from gateway.models.usage import UsageLog, UsageRollup, UsageRollupDirtyHour
from gateway.repositories.base_repository import BaseRepository

# The gateway-run tools the rollups keep a set of measures for. The usage service's
# tool list must match it; ``tests/unit/test_usage_rollups.py`` holds the two together.
ROLLUP_TOOLS: tuple[str, ...] = ("web_search", "web_fetch", "code_execution")

# The usage columns an hour's rollups are grouped by, under the same names, so a
# condition over them reads the same against either table.
KEYS: tuple[str, ...] = (
    "workspace_id",
    "model",
    "requested_model",
    "provider",
    "endpoint",
    "user_id",
    "api_key_id",
    "source",
    "source_label",
    "policy_name",
    "status",
    "status_code",
)

# Past this many marked hours in a window, a read takes the whole window from the
# rows: the rollups are still being built (as after the migration that adds them)
# or a bulk change marked much of the history, and the rows read in one pass then.
MAX_DIRTY_HOURS = 48

# The relation :meth:`UsageRollupRepository.rows` returns, as a caller outside the repositories names it.
UsageRows = Subquery

_HOUR = timedelta(hours=1)
# Any fixed number serves; it only has to be this refresh's alone.
_REFRESH_LOCK = 0x7573_6167_6572_6F6C  # "usagerol"


def _tool_cost(tool: str) -> Any:
    """USD charged for one tool on a row: its billable calls at the per-call rate the row recorded.

    The row's ``cost`` mixes tokens and tools, so per-tool spend comes from the meter,
    and the rate is read off the row rather than the price list, so a row keeps the
    rate it was billed at after the operator changes the price.
    """
    rate = func.coalesce(UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "unit_rate")].as_float(), 0.0)
    return tool_calls_expr(tool) * rate


def _row_values() -> dict[str, Any]:
    """What one usage row contributes to each measure, by measure name. Every one of them sums."""
    values: dict[str, Any] = {
        "cost": UsageLog.cost,
        "prompt_tokens": UsageLog.prompt_tokens,
        "completion_tokens": UsageLog.completion_tokens,
        "total_tokens": UsageLog.total_tokens,
        "cache_read_tokens": UsageLog.cache_read_tokens,
        "cache_write_tokens": UsageLog.cache_write_tokens,
        "cache_write_1h_tokens": UsageLog.cache_write_1h_tokens,
        "reasoning_tokens": UsageLog.reasoning_tokens,
        "billed_input_tokens": billed_meter("total_input_tokens", UsageLog.prompt_tokens),
        "billed_output_tokens": billed_meter("completion_tokens", UsageLog.completion_tokens),
        "billed_cache_read_tokens": billed_meter("cache_read_tokens", UsageLog.cache_read_tokens),
        "billed_cache_write_tokens": billed_meter("cache_write_tokens", UsageLog.cache_write_tokens),
        "latency_ms": UsageLog.latency_ms,
        "latency_count": case((UsageLog.latency_ms.is_not(None), 1), else_=0),
    }
    for tool in ROLLUP_TOOLS:
        calls = tool_calls_expr(tool)
        ran = calls.is_not(None)
        values[f"{tool}_calls"] = calls
        # Counted only where the row billed calls of the tool, as the tool table reads them.
        values[f"{tool}_errors"] = case(
            (ran, UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "errors")].as_integer())
        )
        values[f"{tool}_cost"] = _tool_cost(tool)
        values[f"{tool}_rows"] = case((ran, 1), else_=0)
    return values


_MEASURES: tuple[str, ...] = tuple(_row_values())


def _hour_of(timestamp: Any) -> Any:
    """The UTC hour a timestamp falls in, as a ``timestamptz``, the way the trigger marks it."""
    return func.timezone("UTC", func.date_trunc("hour", func.timezone("UTC", timestamp)))


def _raw(conditions: Sequence[ColumnElement[bool]], *, with_latencies: bool) -> Select[Any]:
    """The rows the conditions leave, each standing for itself.

    ``with_latencies`` adds each row's latency as a one-value list beside a
    count of one (PostgreSQL only), the shape the rollups keep theirs in.
    """
    values = _row_values()
    stmt = select(
        *(getattr(UsageLog, key).label(key) for key in KEYS),
        needs_pricing_condition().label("needs_pricing"),
        UsageLog.timestamp.label("ts"),
        literal(1, BigInteger).label("rows"),
        UsageLog.timestamp.label("first_at"),
        UsageLog.timestamp.label("last_at"),
        *(values[name].label(name) for name in _MEASURES),
    ).where(*conditions)
    if with_latencies:
        stmt = stmt.add_columns(
            postgresql.array([UsageLog.latency_ms]).label("latency_values"),
            postgresql.array([literal(1, Integer)]).label("latency_counts"),
        )
    return stmt


def _summed(conditions: Sequence[ColumnElement[bool]]) -> Select[Any]:
    """The rollups the conditions leave, in :func:`_raw`'s columns and order."""
    rollup = UsageRollup.__table__.c
    return select(
        *(rollup[key] for key in KEYS),
        rollup.needs_pricing,
        rollup.hour.label("ts"),
        rollup.rows,
        rollup.first_at,
        rollup.last_at,
        *(rollup[name] for name in _MEASURES),
        rollup.latency_values,
        rollup.latency_counts,
    ).where(*conditions)


class _Unservable(Exception):
    """A condition reads a usage column the rollups do not keep."""


def _on_rollups(condition: ColumnElement[bool]) -> ColumnElement[bool]:
    """``condition`` over the rollups' key columns, or :class:`_Unservable` if it reads anything else."""
    rollup = UsageRollup.__table__.c

    def swap(element: Any, **_: Any) -> Any:
        if isinstance(element, Column) and element.table is UsageLog.__table__:
            if element.name not in KEYS:
                raise _Unservable(element.name)
            return rollup[element.name]
        return None

    return replacement_traverse(condition, {}, swap)


def _reads_timestamp(condition: ColumnElement[bool]) -> bool:
    return any(
        isinstance(element, Column) and element.table is UsageLog.__table__ and element.name == "timestamp"
        for element in iterate(condition)
    )


def _is_bound(condition: ColumnElement[bool], operator: Any, value: datetime) -> bool:
    """Whether ``condition`` is ``timestamp <operator> value`` and nothing else."""
    if not isinstance(condition, BinaryExpression) or condition.operator is not operator:
        return False
    left, right = condition.left, condition.right
    is_timestamp = isinstance(left, Column) and left.table is UsageLog.__table__ and left.name == "timestamp"
    return is_timestamp and getattr(right, "value", None) == value


def _ceil_hour(moment: datetime) -> datetime:
    floor = _floor_hour(moment)
    return floor if floor == utc_bound(moment) else floor + _HOUR


def _floor_hour(moment: datetime) -> datetime:
    """The UTC hour ``moment`` falls in. In UTC because an offset of half an hour has its own hours."""
    return utc_bound(moment).astimezone(UTC).replace(minute=0, second=0, microsecond=0)


def _spans(hours: Sequence[datetime]) -> list[tuple[datetime, datetime]]:
    """Sorted hours as the fewest ``[start, end)`` spans that cover them."""
    spans: list[tuple[datetime, datetime]] = []
    for hour in sorted(hours):
        if spans and spans[-1][1] == hour:
            spans[-1] = (spans[-1][0], hour + _HOUR)
        else:
            spans.append((hour, hour + _HOUR))
    return spans


def _in_spans(column: Any, spans: Sequence[tuple[datetime, datetime]]) -> list[ColumnElement[bool]]:
    return [and_(column >= start, column < end) for start, end in spans]


class UsageRollupRepository(BaseRepository[UsageRollup, Never, Never]):
    """The rollups' reads and their refresh, in the open block of a Unit of Work."""

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, UsageRollup)

    async def rows(
        self,
        conditions: Sequence[ColumnElement[bool]],
        start: datetime,
        end: datetime,
        *,
        bucket: UsageBucketGrain,
        exact: bool = False,
    ) -> Subquery:
        """The usage rows ``conditions`` leave in ``[start, end)``, in one relation, rollups wherever they serve.

        ``conditions`` include the window, as ``timestamp >= start`` and
        ``timestamp < end``. ``exact`` asks for every row on its own, for a read
        that ranks single rows (a ranking by percentile). On PostgreSQL every
        relation row carries its latencies (``latency_values``, ``latency_counts``),
        so a percentile reads them from either source.
        """
        postgres = dialect_name(self.db) == "postgresql"
        summed_conditions = self._rollup_conditions(conditions, start, end) if not exact else None
        if summed_conditions is None or bucket == "5min" or not postgres:
            return _raw(conditions, with_latencies=postgres).subquery("usage_rows")
        whole_start, whole_end = _ceil_hour(start), _floor_hour(end)
        if whole_start >= whole_end:
            return _raw(conditions, with_latencies=postgres).subquery("usage_rows")
        dirty = UsageRollupDirtyHour.__table__.c
        marked = list(
            (
                await self.db.execute(
                    select(dirty.hour).where(dirty.hour >= whole_start, dirty.hour < whole_end).distinct()
                )
            ).scalars()
        )
        if len(marked) > MAX_DIRTY_HOURS:
            return _raw(conditions, with_latencies=postgres).subquery("usage_rows")
        marked_spans = _spans(marked)
        rollup = UsageRollup.__table__.c
        current = [rollup.hour >= whole_start, rollup.hour < whole_end]
        if marked_spans:
            current.append(~or_(*_in_spans(rollup.hour, marked_spans)))
        from_rows = or_(
            UsageLog.timestamp < whole_start,
            UsageLog.timestamp >= whole_end,
            *_in_spans(UsageLog.timestamp, marked_spans),
        )
        return union_all(
            _summed([*summed_conditions, *current]),
            _raw([*conditions, from_rows], with_latencies=True),
        ).subquery("usage_rows")

    @staticmethod
    def _rollup_conditions(
        conditions: Sequence[ColumnElement[bool]], start: datetime, end: datetime
    ) -> list[ColumnElement[bool]] | None:
        """``conditions`` over the rollups, the window left out, or None when one reads a column they do not keep.

        The window's two bounds are left out because whole hours stand in for
        them. Any other condition on the timestamp is a window this read does not
        know, so it takes the rows.
        """
        summed: list[ColumnElement[bool]] = []
        for condition in conditions:
            if _reads_timestamp(condition):
                if _is_bound(condition, operators.ge, start) or _is_bound(condition, operators.lt, end):
                    continue
                return None
            try:
                summed.append(_on_rollups(condition))
            except _Unservable:
                return None
        return summed

    async def refresh(self, max_hours: int, *, now: datetime) -> int:
        """Rebuild up to ``max_hours`` of the latest marked hours before ``now``'s, and return how many.

        Latest first, so after the rollups first appear the weeks a dashboard reads
        are built before the history. The hour ``now`` falls in is left marked: a
        window that ends now reads it from its rows as a partial hour anyway, and
        it is built once it is over.

        One refresh at a time, under a transaction-scoped advisory lock: two building
        the same hour would each delete the sums the other has not committed yet and
        both insert theirs. The marks are taken before the rows are read, so a write
        that commits in between leaves its mark for the next refresh, which then
        builds the same hour again.
        """
        await self.db.execute(select(func.pg_advisory_xact_lock(_REFRESH_LOCK)))
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
        hours = sorted(set(taken.scalars()))
        if not hours:
            return 0
        rollup = UsageRollup.__table__.c
        await self.db.execute(delete(UsageRollup).where(rollup.hour.in_(hours)))
        spans = _spans(hours)
        values = _row_values()
        hour = _hour_of(UsageLog.timestamp)
        needs_pricing = needs_pricing_condition()
        # Grouped twice: first by every key and the latency, so each distinct
        # latency is counted, then by the keys alone, which gathers those counts
        # into the hour's two lists beside the other sums.
        by_latency = (
            select(
                *(getattr(UsageLog, key).label(key) for key in KEYS),
                needs_pricing.label("needs_pricing"),
                hour.label("hour"),
                UsageLog.latency_ms.label("latency"),
                func.count().label("rows"),
                func.min(UsageLog.timestamp).label("first_at"),
                func.max(UsageLog.timestamp).label("last_at"),
                *(func.sum(values[name]).label(name) for name in _MEASURES),
            )
            .where(or_(*_in_spans(UsageLog.timestamp, spans)))
            .group_by(*(getattr(UsageLog, key) for key in KEYS), needs_pricing, hour, UsageLog.latency_ms)
            .subquery()
        )
        counted = by_latency.c
        measured = counted.latency.is_not(None)
        groups = [*(counted[key] for key in KEYS), counted.needs_pricing, counted.hour]
        summed = select(
            *groups,
            func.sum(counted.rows),
            func.min(counted.first_at),
            func.max(counted.last_at),
            *(func.sum(counted[name]) for name in _MEASURES),
            func.array_agg(counted.latency).filter(measured),
            func.array_agg(cast(counted.rows, Integer)).filter(measured),
        ).group_by(*groups)
        await self.db.execute(
            insert(UsageRollup).from_select(
                [
                    *KEYS,
                    "needs_pricing",
                    "hour",
                    "rows",
                    "first_at",
                    "last_at",
                    *_MEASURES,
                    "latency_values",
                    "latency_counts",
                ],
                summed,
            )
        )
        return len(hours)

    async def marked_hours(self) -> int:
        """How many distinct hours are waiting for a refresh."""
        dirty = UsageRollupDirtyHour.__table__.c
        return int((await self.db.execute(select(func.count(func.distinct(dirty.hour))))).scalar_one())
