"""Queries behind the usage summary and the grouped series: totals, breakdowns, tools, failures and buckets.

Like the log's reads, each takes the conditions the caller already built from the
request's filters and its scope. The billed composition aggregates are shared by
the summary series, the grand totals and the grouped series, so all three
reconcile by construction.
"""

import uuid
from collections import Counter
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any, Never

from sqlalchemy import ColumnElement, String, case, cast, func, null, or_, select

from gateway.core.sql import UsageBucketGrain, bucket_expr, canonical_bucket, dialect_name, utc_bound
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import (
    API_KEY_LABEL,
    CHANNEL,
    CHANNEL_KEY,
    TOOL_METER_NAMESPACE,
    USER_LABEL,
    LabelJoin,
    SortOrder,
    billed_cache_read_sum,
    billed_cache_write_sum,
    billed_input_sum,
    billed_output_sum,
    imported_cost_sum,
    needs_pricing_condition,
    request_count,
    status_count,
    tag_expr,
    tool_calls_expr,
)
from gateway.models.usage import UsageLog
from gateway.repositories.base_repository import BaseRepository
from gateway.repositories.tenancy.workspace_repository import workspace_label
from gateway.schemas.usage import (
    BreakdownDimension,
    UsageBreakdownRankBy,
    UsageErrorCodeRow,
    UsageGroupedSeriesPoint,
    UsageGroupRow,
    UsageSeriesPoint,
    UsageSessionRow,
    UsageToolRow,
    UsageTotals,
    error_class_for,
)


@dataclass(frozen=True)
class _Breakdown:
    """What a breakdown groups by: a column or expression, the join that names its values, and any join it reads."""

    column: Any
    label: LabelJoin | None = None
    # (entity, on) pairs the column itself reads, outer-joined so no row drops out.
    reads: tuple[tuple[Any, Any], ...] = ()
    # Whether the column holds UUIDs, which a key filter has to bind as UUIDs.
    is_uuid: bool = False


_BREAKDOWNS: dict[BreakdownDimension, _Breakdown] = {
    "model": _Breakdown(UsageLog.model),
    "user": _Breakdown(UsageLog.user_id, USER_LABEL),
    "api_key": _Breakdown(UsageLog.api_key_id, API_KEY_LABEL),
    "source": _Breakdown(UsageLog.source),
    "source_label": _Breakdown(UsageLog.source_label),
    "endpoint": _Breakdown(UsageLog.endpoint),
    "provider": _Breakdown(UsageLog.provider),
    "policy": _Breakdown(UsageLog.policy_name),
    "workspace": _Breakdown(UsageLog.workspace_id, workspace_label(UsageLog.workspace_id), is_uuid=True),
    "channel": _Breakdown(CHANNEL, reads=((CHANNEL_KEY, CHANNEL_KEY.c.id == UsageLog.api_key_id),)),
}


def _joined(stmt: Any, spec: _Breakdown, *, with_label: bool) -> Any:
    """``stmt`` outer-joined to what the breakdown reads and, if asked, to what names it."""
    for entity, on in spec.reads:
        stmt = stmt.outerjoin(entity, on)
    if with_label and spec.label is not None:
        stmt = stmt.outerjoin(spec.label.entity, spec.label.on)
    return stmt


def _in_keys(spec: _Breakdown, keys: Collection[str | None]) -> ColumnElement[bool]:
    """Match the rows of these groups, the NULL group included when it is one of them."""
    named = [uuid.UUID(k) if spec.is_uuid else k for k in keys if k is not None]
    matches = [spec.column.in_(named)] if named else []
    if None in keys:
        matches.append(spec.column.is_(None))
    return or_(*matches)


def _p95_latency() -> Any:
    """A group's nearest-rank 95th-percentile latency over its requests, as a PostgreSQL ordered-set aggregate.

    ``percentile_disc`` skips NULL inputs, so nulling the absorbed attempts leaves
    them out as :meth:`UsageSummaryRepository.group_p95_latency_ms` does.
    """
    return func.percentile_disc(0.95).within_group(case((UsageLog.status != "absorbed", UsageLog.latency_ms)).asc())


def _rank(spec: _Breakdown, label: Any, rank_by: UsageBreakdownRankBy, status_filter: str | None) -> Any:
    """The value a breakdown's groups are ranked by, for the summary's breakdowns and the series' groups alike.

    ``name`` is the group's label where it has one, else its key, ignoring case.
    ``p95`` is :func:`_p95_latency`, which only PostgreSQL can order by.
    """
    cost = func.coalesce(func.sum(UsageLog.cost), 0.0)
    if rank_by == "name":
        key = cast(spec.column, String)
        return func.lower(key if spec.label is None else func.coalesce(label, key))
    if rank_by == "p95":
        return _p95_latency()
    if rank_by == "billed":
        return cost - imported_cost_sum()
    if rank_by == "tokens":
        return billed_input_sum() + billed_output_sum()
    if rank_by == "requests":
        return request_count(status_filter)
    if rank_by == "imported":
        return imported_cost_sum()
    if rank_by == "errors":
        return status_count("error")
    return cost


def _ranked_by_p95(groups: list[UsageGroupRow], rank_order: SortOrder) -> list[UsageGroupRow]:
    """``groups`` in the order PostgreSQL's ranking by p95 gives: p95 as asked, then the key, a missing value last."""
    by_key = sorted(groups, key=lambda group: (group.key is None, group.key or ""))
    sign = 1 if rank_order == "asc" else -1
    return sorted(by_key, key=lambda group: (group.p95_latency_ms is None, sign * (group.p95_latency_ms or 0)))


def _key(value: Any) -> str | None:
    """A group key as the response carries it: a UUID column's value as its string."""
    return None if value is None else str(value)


@dataclass(frozen=True)
class SessionDetail:
    """Where a session came from, as :meth:`UsageSummaryRepository.session_details` reads it."""

    source: str | None
    api_key_name: str | None


def _most_common[T](counts: Counter[T]) -> T:
    """The value most requests carry; on a tie, a named value over none, then the first by name."""
    return min(counts, key=lambda value: (-counts[value], value is None, str(value)))


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
                    billed_cache_read_sum(),
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
            billed_cache_read_tokens=int(row[16]),
        )

    async def breakdown(
        self,
        dimension: BreakdownDimension,
        conditions: list[ColumnElement[bool]],
        *,
        limit: int | None,
        status_filter: str | None = None,
        with_span: bool = False,
        rank_by: UsageBreakdownRankBy = "cost",
        rank_order: SortOrder = "desc",
    ) -> list[UsageGroupRow]:
        """Spend/tokens/requests grouped by ``dimension``, ranked by ``rank_by``, at most ``limit`` groups.

        ``tokens`` is the *billed* total (input including both cache buckets, plus
        output, via ``billed_meter``), the same quantity the series composition and
        the grouped series report, so every analytics surface agrees on what a
        token count means. ``rank_by`` and ``rank_order`` order the groups, and so
        pick the ``limit`` that are kept; a group with no value to rank by comes
        last, and a tie falls to the key, the NULL group last, in either direction.
        Ranked by ``p95``, each row carries its p95. ``with_span`` also reads each
        group's first and last request in the same pass and returns session rows,
        for ``source_label``.
        """
        spec = _BREAKDOWNS[dimension]
        column, label_join = spec.column, spec.label
        cost_sum = func.coalesce(func.sum(UsageLog.cost), 0.0)
        # The label rides along in the same pass rather than costing a second query or
        # a client-side table dump. Grouped by as well as selected: it is functionally
        # dependent on the joined row's primary key, but only PostgreSQL infers that,
        # and this has to run on SQLite too. Outer-joined so a group whose entity was
        # deleted keeps its row (with a null label) instead of vanishing from a
        # breakdown that must still reconcile against the totals.
        label_column = label_join.label if label_join is not None else null()
        rank = _rank(spec, label_column, rank_by, status_filter)
        # SQLite has no percentile aggregate, so there every group is read and ranked
        # by the p95 the window-function pass computes, before the limit applies.
        p95_in_python = rank_by == "p95" and dialect_name(self.db) == "sqlite"
        stmt = select(
            column,
            label_column,
            cost_sum,
            billed_input_sum() + billed_output_sum(),
            request_count(status_filter),
            imported_cost_sum(),
            status_count("error"),
            billed_cache_read_sum(),
        )
        if with_span:
            stmt = stmt.add_columns(func.min(UsageLog.timestamp), func.max(UsageLog.timestamp))
        p95_in_sql = rank_by == "p95" and not p95_in_python
        if p95_in_sql:
            stmt = stmt.add_columns(rank)
        stmt = _joined(stmt, spec, with_label=True)
        group_by = (column,) if label_join is None else (column, label_column)
        stmt = stmt.where(*conditions).group_by(*group_by)
        if not p95_in_python:
            direction = rank.asc() if rank_order == "asc" else rank.desc()
            stmt = stmt.order_by(direction.nulls_last(), column.asc().nulls_last())
            if limit is not None:
                stmt = stmt.limit(limit)
        rows = (await self.db.execute(stmt)).all()
        p95 = await self._group_p95(spec, conditions) if p95_in_python else {}
        groups: list[UsageGroupRow] = []
        for row in rows:
            key = _key(row[0])
            figures = {
                "key": key,
                "label": row[1],
                "cost": float(row[2]),
                "tokens": int(row[3]),
                "requests": int(row[4]),
                "imported_cost": float(row[5]),
                "error_count": int(row[6]),
                "cache_read_tokens": int(row[7]),
                "p95_latency_ms": (None if row[-1] is None else int(row[-1])) if p95_in_sql else p95.get(key),
            }
            groups.append(
                UsageSessionRow(**figures, first_at=utc_bound(row[8]), last_at=utc_bound(row[9]))
                if with_span
                else UsageGroupRow(**figures)
            )
        if p95_in_python:
            groups = _ranked_by_p95(groups, rank_order)[:limit]
        return groups

    async def group_p95_latency_ms(
        self,
        dimension: BreakdownDimension,
        keys: Collection[str | None],
        conditions: list[ColumnElement[bool]],
    ) -> dict[str | None, int]:
        """Each of these groups' nearest-rank 95th-percentile latency, in one grouped pass.

        The same value the totals' p95 takes over the window (``percentile_disc``,
        absorbed attempts left out), per group. SQLite has no ordered-set aggregate,
        so there each group's latencies are ranked with window functions and the row
        at rank ``ceil(0.95 * n)`` kept, which is the value ``percentile_disc`` returns.
        """
        if not keys:
            return {}
        spec = _BREAKDOWNS[dimension]
        return await self._group_p95(spec, [*conditions, _in_keys(spec, keys)])

    async def _group_p95(self, spec: _Breakdown, conditions: list[ColumnElement[bool]]) -> dict[str | None, int]:
        """The p95 of every group the conditions leave, for :meth:`group_p95_latency_ms` and the SQLite p95 ranking."""
        measured = [*conditions, UsageLog.status != "absorbed", UsageLog.latency_ms.is_not(None)]
        if dialect_name(self.db) != "sqlite":
            p95 = func.percentile_disc(0.95).within_group(UsageLog.latency_ms.asc())
            stmt = _joined(select(spec.column, p95), spec, with_label=False).where(*measured).group_by(spec.column)
            return {_key(key): int(value) for key, value in (await self.db.execute(stmt)).all() if value is not None}
        ranked = (
            _joined(
                select(
                    spec.column.label("group_key"),
                    UsageLog.latency_ms.label("latency"),
                    func.row_number()
                    .over(partition_by=spec.column, order_by=UsageLog.latency_ms.asc())
                    .label("position"),
                    func.count().over(partition_by=spec.column).label("size"),
                ),
                spec,
                with_label=False,
            )
            .where(*measured)
            .subquery()
        )
        rows = (
            await self.db.execute(
                select(ranked.c.group_key, ranked.c.latency).where(
                    ranked.c.position == (ranked.c.size * 95 + 99) // 100
                )
            )
        ).all()
        return {_key(key): int(value) for key, value in rows}

    async def session_details(
        self,
        keys: Collection[str | None],
        conditions: list[ColumnElement[bool]],
        *,
        status_filter: str | None = None,
    ) -> dict[str, SessionDetail]:
        """The provenance source and API key name most of each of these sessions' requests carry.

        One grouped pass over the sessions on the page, grouped by session, source and
        key name, so both answers come from the same counts. Requests, not rows: a routed
        request's abandoned attempts are left out, as the breakdown's counts leave them,
        unless ``status_filter`` asks for exactly those (see ``request_count``).
        """
        named = [key for key in keys if key is not None]
        if not named:
            return {}
        counted = [] if status_filter == "absorbed" else [UsageLog.status != "absorbed"]
        rows = (
            await self.db.execute(
                select(UsageLog.source_label, UsageLog.source, API_KEY_LABEL.label, func.count())
                .outerjoin(API_KEY_LABEL.entity, API_KEY_LABEL.on)
                .where(*conditions, UsageLog.source_label.in_(named), *counted)
                .group_by(UsageLog.source_label, UsageLog.source, API_KEY_LABEL.label)
            )
        ).all()
        sources: dict[str, Counter[str]] = {}
        key_names: dict[str, Counter[str | None]] = {}
        for label, source, key_name, count in rows:
            sources.setdefault(label, Counter())[source] += count
            key_names.setdefault(label, Counter())[key_name] += count
        return {
            label: SessionDetail(source=_most_common(sources[label]), api_key_name=_most_common(key_names[label]))
            for label in sources
        }

    async def tag_breakdown(
        self,
        key: str,
        conditions: list[ColumnElement[bool]],
        *,
        limit: int | None,
        status_filter: str | None = None,
    ) -> list[UsageGroupRow]:
        """Spend/tokens/requests grouped by the value of request tag ``key``, biggest spend first.

        Rows that do not carry the tag group under a null key. ``tokens`` is billed, as in :meth:`breakdown`.
        """
        value = tag_expr(key)
        cost_sum = func.coalesce(func.sum(UsageLog.cost), 0.0)
        stmt = (
            select(
                value,
                cost_sum,
                billed_input_sum() + billed_output_sum(),
                request_count(status_filter),
                imported_cost_sum(),
                status_count("error"),
                billed_cache_read_sum(),
            )
            .where(*conditions)
            .group_by(value)
            .order_by(cost_sum.desc())
        )
        if limit is not None:
            stmt = stmt.limit(limit)
        rows = (await self.db.execute(stmt)).all()
        return [
            UsageGroupRow(
                key=row[0],
                cost=float(row[1]),
                tokens=int(row[2]),
                requests=int(row[3]),
                imported_cost=float(row[4]),
                error_count=int(row[5]),
                cache_read_tokens=int(row[6]),
            )
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
                    imported_cost_sum(),
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
                imported_cost=float(row[9]),
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
        spec = _BREAKDOWNS[dimension]
        column = spec.column
        named_keys = [uuid.UUID(k) for k in named] if spec.is_uuid else list(named)
        # The synthesized groups are encoded as (key NULL, fold flag) rather than a
        # sentinel key string: GROUP BY treats NULLs as equal on both dialects, and
        # no sentinel can be trusted never to collide with a real key. A NULL column
        # value never matches ``IN``, so it lands in the CASE's ``else`` arm; the
        # fold flag then separates a NULL group that ranked in the top N (a real
        # ``key=None`` series, e.g. a deleted user) from the past-top-N remainder.
        key_expr = case((column.in_(named_keys), column), else_=null())
        if keeps_null:
            fold_expr = case((column.is_(None), 0), (column.in_(named_keys), 0), else_=1)
        else:
            fold_expr = case((column.in_(named_keys), 0), else_=1)
        expr = bucket_expr(dialect_name(self.db), bucket, UsageLog.timestamp)
        stmt = select(
            expr,
            key_expr,
            fold_expr,
            func.coalesce(func.sum(UsageLog.cost), 0.0),
            billed_input_sum() + billed_output_sum(),
            request_count(status_filter),
            imported_cost_sum(),
        )
        rows = (
            await self.db.execute(
                _joined(stmt, spec, with_label=False).where(*conditions).group_by(expr, key_expr, fold_expr)
            )
        ).all()
        points = [
            UsageGroupedSeriesPoint(
                bucket_start=canonical_bucket(row[0], bucket),
                key=_key(row[1]),
                is_other=bool(row[2]),
                cost=float(row[3]),
                tokens=int(row[4]),
                requests=int(row[5]),
                imported_cost=float(row[6]),
            )
            for row in rows
        ]
        points.sort(key=lambda p: p.bucket_start)
        return points
