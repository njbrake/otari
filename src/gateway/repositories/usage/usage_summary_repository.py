"""Queries behind the usage summary and the grouped series: totals, breakdowns, tools, failures and buckets.

Like the log's reads, each takes the conditions the caller already built from the
request's filters and its scope. The billed composition aggregates are shared by
the summary series, the grand totals and the grouped series, so all three
reconcile by construction.
"""

from collections.abc import Collection
from typing import Any, Never

from sqlalchemy import ColumnElement, case, func, null, select

from gateway.core.sql import UsageBucketGrain, bucket_expr, canonical_bucket, dialect_name
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import (
    API_KEY_LABEL,
    TOOL_METER_NAMESPACE,
    USER_LABEL,
    LabelJoin,
    billed_cache_read_sum,
    billed_cache_write_sum,
    billed_input_sum,
    billed_output_sum,
    imported_cost_sum,
    needs_pricing_condition,
    request_count,
    status_count,
    tool_calls_expr,
)
from gateway.models.usage import UsageLog
from gateway.repositories.base_repository import BaseRepository
from gateway.schemas.usage import (
    BreakdownDimension,
    UsageErrorCodeRow,
    UsageGroupedSeriesPoint,
    UsageGroupRow,
    UsageSeriesPoint,
    UsageToolRow,
    UsageTotals,
    error_class_for,
)

# The column each breakdown groups by, and the join that names its values.
_BREAKDOWN_COLUMNS: dict[BreakdownDimension, tuple[Any, LabelJoin | None]] = {
    "model": (UsageLog.model, None),
    "user": (UsageLog.user_id, USER_LABEL),
    "api_key": (UsageLog.api_key_id, API_KEY_LABEL),
    "source": (UsageLog.source, None),
    "source_label": (UsageLog.source_label, None),
    "endpoint": (UsageLog.endpoint, None),
    "provider": (UsageLog.provider, None),
}


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


class UsageSummaryRepository(BaseRepository[UsageLog, Never, Never]):
    """Aggregate usage rows in the open block of a Unit of Work."""

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, UsageLog)

    async def totals(self, conditions: list[ColumnElement[bool]], status_filter: str | None = None) -> UsageTotals:
        """Grand totals over the rows the conditions leave."""
        row = (
            await self.db.execute(
                select(
                    func.coalesce(func.sum(UsageLog.cost), 0.0),
                    func.coalesce(func.sum(UsageLog.prompt_tokens), 0),
                    func.coalesce(func.sum(UsageLog.completion_tokens), 0),
                    func.coalesce(func.sum(UsageLog.total_tokens), 0),
                    func.coalesce(func.sum(UsageLog.cache_read_tokens), 0),
                    func.coalesce(func.sum(UsageLog.cache_write_tokens), 0),
                    func.coalesce(func.sum(UsageLog.cache_write_1h_tokens), 0),
                    request_count(status_filter),
                    status_count("error"),
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
                    status_count("absorbed"),
                    imported_cost_sum(),
                    func.coalesce(func.sum(UsageLog.reasoning_tokens), 0),
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
            reasoning_tokens=int(row[15]),
        )

    async def breakdown(
        self,
        dimension: BreakdownDimension,
        conditions: list[ColumnElement[bool]],
        *,
        limit: int | None,
        status_filter: str | None = None,
    ) -> list[UsageGroupRow]:
        """Spend/tokens/requests grouped by ``dimension``, biggest spend first, at most ``limit`` groups.

        ``tokens`` is the *billed* total (input including both cache buckets, plus
        output, via ``billed_meter``), the same quantity the series composition and
        the grouped series report, so every analytics surface agrees on what a
        token count means.
        """
        column, label_join = _BREAKDOWN_COLUMNS[dimension]
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
        rows = (await self.db.execute(stmt)).all()
        return [
            UsageGroupRow(key=row[0], label=row[1], cost=float(row[2]), tokens=int(row[3]), requests=int(row[4]))
            for row in rows
        ]

    async def tool_usage(self, tool: str, conditions: list[ColumnElement[bool]]) -> UsageToolRow | None:
        """One tool's calls, failures, spend and requests, or None when the rows never ran it.

        One aggregate per tool rather than a ``GROUP BY`` over the meter map: a JSON
        map's keys cannot be grouped portably across SQLite and PostgreSQL
        (``json_each`` versus ``jsonb_each``). Cost comes from each row's charge line
        rather than the row total, because a row's ``cost`` also carries tokens.
        """
        calls = tool_calls_expr(tool)
        errors = UsageLog.billing_meters[(TOOL_METER_NAMESPACE, tool, "errors")].as_integer()
        row = (
            await self.db.execute(
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
            return None
        return UsageToolRow(tool=tool, calls=int(row[0]), errors=int(row[1]), requests=int(row[2]), cost=float(row[3]))

    async def errors_by_status_code(
        self, conditions: list[ColumnElement[bool]], *, limit: int
    ) -> list[UsageErrorCodeRow]:
        """Failures grouped by status code, most frequent first, at most ``limit`` codes.

        A GROUP BY rather than substring matching over provider-specific error prose.
        """
        request_count = func.count()
        rows = (
            await self.db.execute(
                select(UsageLog.status_code, request_count)
                .where(*conditions, UsageLog.status == "error")
                .group_by(UsageLog.status_code)
                .order_by(request_count.desc())
                .limit(limit)
            )
        ).all()
        return [
            UsageErrorCodeRow(status_code=row[0], error_class=error_class_for(row[0]), requests=int(row[1]))
            for row in rows
        ]

    async def series(
        self, conditions: list[ColumnElement[bool]], *, status_filter: str | None, bucket: UsageBucketGrain
    ) -> dict[str, UsageSeriesPoint]:
        """The populated time buckets, keyed by canonical ``bucket_start``."""
        expr = bucket_expr(dialect_name(self.db), bucket, UsageLog.timestamp)
        rows = (
            await self.db.execute(
                select(
                    expr,
                    func.coalesce(func.sum(UsageLog.cost), 0.0),
                    func.coalesce(func.sum(UsageLog.total_tokens), 0),
                    request_count(status_filter),
                    status_count("error"),
                    billed_input_sum(),
                    billed_cache_read_sum(),
                    billed_cache_write_sum(),
                    billed_output_sum(),
                )
                .where(*conditions)
                .group_by(expr)
            )
        ).all()
        return {
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
            for row in rows
        }

    async def grouped_series(
        self,
        dimension: BreakdownDimension,
        conditions: list[ColumnElement[bool]],
        *,
        status_filter: str | None,
        bucket: UsageBucketGrain,
        named: Collection[str],
        keeps_null: bool,
    ) -> list[UsageGroupedSeriesPoint]:
        """The (bucket, group) cells of a grouped series, sparse, in bucket order.

        ``named`` are the groups that keep series of their own; every other group
        collapses into the fold in SQL rather than being fetched and folded here, so
        the row count stays bounded by buckets × (``len(named)`` + 2) regardless of
        cardinality. ``keeps_null`` says a NULL group ranked among them.
        """
        column, _ = _BREAKDOWN_COLUMNS[dimension]
        # The synthesized groups are encoded as (key NULL, fold flag) rather than a
        # sentinel key string: GROUP BY treats NULLs as equal on both dialects, and
        # no sentinel can be trusted never to collide with a real key. A NULL column
        # value never matches ``IN``, so it lands in the CASE's ``else`` arm; the
        # fold flag then separates a NULL group that ranked in the top N (a real
        # ``key=None`` series, e.g. a deleted user) from the past-top-N remainder.
        key_expr = case((column.in_(named), column), else_=null())
        if keeps_null:
            fold_expr = case((column.is_(None), 0), (column.in_(named), 0), else_=1)
        else:
            fold_expr = case((column.in_(named), 0), else_=1)
        expr = bucket_expr(dialect_name(self.db), bucket, UsageLog.timestamp)
        rows = (
            await self.db.execute(
                select(
                    expr,
                    key_expr,
                    fold_expr,
                    func.coalesce(func.sum(UsageLog.cost), 0.0),
                    billed_input_sum() + billed_output_sum(),
                    request_count(status_filter),
                )
                .where(*conditions)
                .group_by(expr, key_expr, fold_expr)
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
        return points
