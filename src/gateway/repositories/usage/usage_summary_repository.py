"""Queries behind the usage summary and the grouped series: totals, breakdowns, tools, failures and buckets.

Each aggregate reads the relation :meth:`UsageRollupRepository.rows` builds over the
window, in which a row stands for ``rows`` usage rows and every measure sums, so one
query answers from an hour's rollups and from the rows alike. The reads that rank
single rows (a percentile) or read a column the rollups do not keep (a tag) take
the conditions and read the rows. The billed composition aggregates are shared by
the summary series, the grand totals and the grouped series, so all three
reconcile by construction.
"""

import uuid
from collections import Counter
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any, Never

from sqlalchemy import ColumnElement, String, Subquery, case, cast, func, null, or_, select

from gateway.core.sql import UsageBucketGrain, bucket_expr, canonical_bucket, dialect_name, utc_bound
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import (
    CHANNEL_KEY,
    LabelJoin,
    SortOrder,
    api_key_label,
    billed_cache_read_sum,
    billed_input_sum,
    billed_output_sum,
    imported_cost_sum,
    request_count,
    status_count,
    tag_expr,
    usage_channel,
    user_label,
)
from gateway.models.usage import SERVED_HERE_SLUG, UsageLog
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


def _breakdown(dimension: BreakdownDimension, rows: Any) -> _Breakdown:
    """What ``dimension`` groups by over ``rows``: ``UsageLog`` itself, or the columns of a usage relation."""
    if dimension == "model":
        return _Breakdown(rows.model)
    if dimension == "user":
        return _Breakdown(rows.user_id, user_label(rows.user_id))
    if dimension == "api_key":
        return _Breakdown(rows.api_key_id, api_key_label(rows.api_key_id))
    if dimension == "source":
        return _Breakdown(rows.source)
    if dimension == "source_label":
        return _Breakdown(rows.source_label)
    if dimension == "endpoint":
        return _Breakdown(rows.endpoint)
    if dimension == "provider":
        return _Breakdown(rows.provider)
    if dimension == "policy":
        return _Breakdown(rows.policy_name)
    if dimension == "workspace":
        return _Breakdown(rows.workspace_id, workspace_label(rows.workspace_id), is_uuid=True)
    # The channel reads the row's key through its own alias, never the key label join.
    channel = usage_channel(rows.source, rows.endpoint, CHANNEL_KEY.c.internal_secret.is_not(None))
    return _Breakdown(channel, reads=((CHANNEL_KEY, CHANNEL_KEY.c.id == rows.api_key_id),))


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


# The aggregates over a usage relation. Each sums a measure, or a row count weighted
# by ``rows``, so it means over the relation what its namesake in ``core/usage_filters``
# means over ``usage_logs``.


def _cost(rows: Any) -> Any:
    return func.coalesce(func.sum(rows.cost), 0.0)


def _requests(rows: Any, status_filter: str | None = None) -> Any:
    """Requests, not rows, as ``core/usage_filters.request_count`` counts them."""
    if status_filter == "absorbed":
        return func.coalesce(func.sum(rows.rows), 0)
    return func.coalesce(func.sum(case((rows.status != "absorbed", rows.rows), else_=0)), 0)


def _with_status(rows: Any, status: str) -> Any:
    return func.coalesce(func.sum(case((rows.status == status, rows.rows), else_=0)), 0)


def _imported_cost(rows: Any) -> Any:
    return func.coalesce(func.sum(case((rows.source != SERVED_HERE_SLUG, rows.cost), else_=0)), 0.0)


def _summed(column: Any) -> Any:
    return func.coalesce(func.sum(column), 0)


def _billed_tokens(rows: Any) -> Any:
    return _summed(rows.billed_input_tokens) + _summed(rows.billed_output_tokens)


def _p95_latency(rows: Any) -> Any:
    """A group's nearest-rank 95th-percentile latency over its requests, as a PostgreSQL ordered-set aggregate.

    Over single rows only (see ``exact`` on :meth:`UsageRollupRepository.rows`).
    ``percentile_disc`` skips NULL inputs, so nulling the absorbed attempts leaves
    them out as :meth:`UsageSummaryRepository.group_p95_latency_ms` does.
    """
    return func.percentile_disc(0.95).within_group(case((rows.status != "absorbed", rows.latency_ms)).asc())


def _rank(rows: Any, spec: _Breakdown, label: Any, rank_by: UsageBreakdownRankBy, status_filter: str | None) -> Any:
    """The value a breakdown's groups are ranked by, for the summary's breakdowns and the series' groups alike.

    ``name`` is the group's label where it has one, else its key, ignoring case.
    ``p95`` is :func:`_p95_latency`, which only PostgreSQL can order by.
    """
    if rank_by == "name":
        key = cast(spec.column, String)
        return func.lower(key if spec.label is None else func.coalesce(label, key))
    if rank_by == "p95":
        return _p95_latency(rows)
    if rank_by == "billed":
        return _cost(rows) - _imported_cost(rows)
    if rank_by == "tokens":
        return _billed_tokens(rows)
    if rank_by == "requests":
        return _requests(rows, status_filter)
    if rank_by == "imported":
        return _imported_cost(rows)
    if rank_by == "errors":
        return _with_status(rows, "error")
    return _cost(rows)


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


class UsageSummaryRepository(BaseRepository[UsageLog, Never, Never]):
    """Aggregate usage in the open block of a Unit of Work.

    ``rows`` is the relation :meth:`UsageRollupRepository.rows` built for the read;
    ``conditions`` are the ones it was built from, for the reads that need the rows.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, UsageLog)

    async def totals(self, rows: Subquery, status_filter: str | None = None) -> UsageTotals:
        """Grand totals over the rows."""
        u = rows.c
        counted = u.status != "absorbed"
        row = (
            await self.db.execute(
                select(
                    _cost(u),
                    _summed(u.prompt_tokens),
                    _summed(u.completion_tokens),
                    _summed(u.total_tokens),
                    _summed(u.cache_read_tokens),
                    _summed(u.cache_write_tokens),
                    _summed(u.cache_write_1h_tokens),
                    _requests(u, status_filter),
                    _with_status(u, "error"),
                    # Averaged over requests, not attempts: an absorbed row carries the
                    # time spent on a candidate that did not serve, and folding it in
                    # would make a policy that recovers quickly look slower than one
                    # that never fails.
                    func.sum(case((counted, u.latency_ms))),
                    func.sum(case((counted, u.latency_count), else_=0)),
                    # Unpriced *served* rows only; see UsageTotals.unpriced_requests. The
                    # predicate is shared with the list filter so the tile and the rows it
                    # sends an operator to agree.
                    func.coalesce(func.sum(case(((u.status == "success") & u.needs_pricing, u.rows), else_=0)), 0),
                    _summed(u.billed_input_tokens),
                    _summed(u.billed_output_tokens),
                    _with_status(u, "absorbed"),
                    _imported_cost(u),
                    _summed(u.reasoning_tokens),
                    _summed(u.billed_cache_read_tokens),
                )
            )
        ).one()
        latency_total, latency_count = row[9], row[10]
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
            avg_latency_ms=float(latency_total) / int(latency_count) if latency_count else None,
            unpriced_requests=int(row[11]),
            billed_input_tokens=int(row[12]),
            billed_output_tokens=int(row[13]),
            absorbed_count=int(row[14]),
            imported_cost=float(row[15]),
            reasoning_tokens=int(row[16]),
            billed_cache_read_tokens=int(row[17]),
        )

    async def breakdown(
        self,
        dimension: BreakdownDimension,
        rows: Subquery,
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
        Ranked by ``p95``, each row carries its p95, which needs ``rows`` built
        ``exact``. ``with_span`` also reads each group's first and last request in
        the same pass and returns session rows, for ``source_label``.
        """
        u = rows.c
        spec = _breakdown(dimension, u)
        column, label_join = spec.column, spec.label
        # The label rides along in the same pass rather than costing a second query or
        # a client-side table dump. Grouped by as well as selected: it is functionally
        # dependent on the joined row's primary key, but only PostgreSQL infers that,
        # and this has to run on SQLite too. Outer-joined so a group whose entity was
        # deleted keeps its row (with a null label) instead of vanishing from a
        # breakdown that must still reconcile against the totals.
        label_column = label_join.label if label_join is not None else null()
        rank = _rank(u, spec, label_column, rank_by, status_filter)
        # SQLite has no percentile aggregate, so there every group is read and ranked
        # by the p95 the window-function pass computes, before the limit applies.
        p95_in_python = rank_by == "p95" and dialect_name(self.db) == "sqlite"
        stmt = select(
            column,
            label_column,
            _cost(u),
            _billed_tokens(u),
            _requests(u, status_filter),
            _imported_cost(u),
            _with_status(u, "error"),
            _summed(u.billed_cache_read_tokens),
        )
        if with_span:
            stmt = stmt.add_columns(func.min(u.first_at), func.max(u.last_at))
        p95_in_sql = rank_by == "p95" and not p95_in_python
        if p95_in_sql:
            stmt = stmt.add_columns(rank)
        stmt = _joined(stmt.select_from(rows), spec, with_label=True)
        group_by = (column,) if label_join is None else (column, label_column)
        stmt = stmt.group_by(*group_by)
        if not p95_in_python:
            direction = rank.asc() if rank_order == "asc" else rank.desc()
            stmt = stmt.order_by(direction.nulls_last(), column.asc().nulls_last())
            if limit is not None:
                stmt = stmt.limit(limit)
        found = (await self.db.execute(stmt)).all()
        p95 = await self._group_p95(_breakdown(dimension, UsageLog), conditions) if p95_in_python else {}
        groups: list[UsageGroupRow] = []
        for row in found:
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
        """Each of these groups' nearest-rank 95th-percentile latency, in one grouped pass over the rows.

        The same value the totals' p95 takes over the window (``percentile_disc``,
        absorbed attempts left out), per group. SQLite has no ordered-set aggregate,
        so there each group's latencies are ranked with window functions and the row
        at rank ``ceil(0.95 * n)`` kept, which is the value ``percentile_disc`` returns.
        """
        if not keys:
            return {}
        spec = _breakdown(dimension, UsageLog)
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
        found = (
            await self.db.execute(
                select(ranked.c.group_key, ranked.c.latency).where(
                    ranked.c.position == (ranked.c.size * 95 + 99) // 100
                )
            )
        ).all()
        return {_key(key): int(value) for key, value in found}

    async def session_details(
        self,
        keys: Collection[str | None],
        rows: Subquery,
        *,
        status_filter: str | None = None,
    ) -> dict[str, SessionDetail]:
        """The provenance source and API key name most of each of these sessions' requests carry.

        One grouped pass over the sessions on the page, grouped by session, source and
        key name, so both answers come from the same counts. Requests, not rows: a routed
        request's abandoned attempts are left out, as the breakdown's counts leave them,
        unless ``status_filter`` asks for those alone (see ``request_count``).
        """
        named = [key for key in keys if key is not None]
        if not named:
            return {}
        u = rows.c
        counted = [] if status_filter == "absorbed" else [u.status != "absorbed"]
        key_name = api_key_label(u.api_key_id)
        found = (
            await self.db.execute(
                select(u.source_label, u.source, key_name.label, func.sum(u.rows))
                .select_from(rows)
                .outerjoin(key_name.entity, key_name.on)
                .where(u.source_label.in_(named), *counted)
                .group_by(u.source_label, u.source, key_name.label)
            )
        ).all()
        sources: dict[str, Counter[str]] = {}
        key_names: dict[str, Counter[str | None]] = {}
        for label, source, key_name, count in found:
            sources.setdefault(label, Counter())[source] += int(count)
            key_names.setdefault(label, Counter())[key_name] += int(count)
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

        Read from the rows, since the rollups keep no tags. Rows that do not carry
        the tag group under a null key. ``tokens`` is billed, as in :meth:`breakdown`.
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
        found = (await self.db.execute(stmt)).all()
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
            for row in found
        ]

    async def tool_usage(self, tools: Collection[str], rows: Subquery) -> list[UsageToolRow]:
        """Each tool's calls, failures, spend and requests in one pass, leaving out a tool the rows never ran.

        Cost comes from each row's charge line rather than the row total, because a
        row's ``cost`` also carries tokens. Requests, not rows: a request that failed
        over through a routing policy writes an absorbed row per recovered attempt,
        and counting those would report more requests using a tool than the Activity
        list shows for the same filter.
        """
        u = rows.c
        counted = u.status != "absorbed"
        columns = [
            column
            for tool in tools
            for column in (
                _summed(u[f"{tool}_calls"]),
                _summed(u[f"{tool}_errors"]),
                func.coalesce(func.sum(case((counted, u[f"{tool}_rows"]), else_=0)), 0),
                func.coalesce(func.sum(u[f"{tool}_cost"]), 0.0),
            )
        ]
        found = (await self.db.execute(select(*columns))).one()
        result: list[UsageToolRow] = []
        for index, tool in enumerate(tools):
            calls, errors, requests, cost = found[index * 4 : index * 4 + 4]
            if calls or errors:
                result.append(
                    UsageToolRow(
                        tool=tool,
                        calls=int(calls),
                        errors=int(errors),
                        requests=int(requests),
                        cost=float(cost),
                    )
                )
        return result

    async def errors_by_status_code(self, rows: Subquery, *, limit: int) -> list[UsageErrorCodeRow]:
        """Failures grouped by status code, most frequent first, at most ``limit`` codes.

        A GROUP BY rather than substring matching over provider-specific error prose.
        """
        u = rows.c
        failures = func.sum(u.rows)
        found = (
            await self.db.execute(
                select(u.status_code, failures)
                .where(u.status == "error")
                .group_by(u.status_code)
                # The code breaks a tie, so the order and the cut at ``limit`` hold however the rows were read.
                .order_by(failures.desc(), u.status_code.asc().nulls_last())
                .limit(limit)
            )
        ).all()
        return [
            UsageErrorCodeRow(status_code=row[0], error_class=error_class_for(row[0]), requests=int(row[1]))
            for row in found
        ]

    async def series(
        self, rows: Subquery, *, status_filter: str | None, bucket: UsageBucketGrain
    ) -> dict[str, UsageSeriesPoint]:
        """The populated time buckets, keyed by canonical ``bucket_start``."""
        u = rows.c
        expr = bucket_expr(dialect_name(self.db), bucket, u.ts)
        found = (
            await self.db.execute(
                select(
                    expr,
                    _cost(u),
                    _summed(u.total_tokens),
                    _requests(u, status_filter),
                    _with_status(u, "error"),
                    _summed(u.billed_input_tokens),
                    _summed(u.billed_cache_read_tokens),
                    _summed(u.billed_cache_write_tokens),
                    _summed(u.billed_output_tokens),
                    _imported_cost(u),
                ).group_by(expr)
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
            for row in found
        }

    async def grouped_series(
        self,
        dimension: BreakdownDimension,
        rows: Subquery,
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
        u = rows.c
        spec = _breakdown(dimension, u)
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
        expr = bucket_expr(dialect_name(self.db), bucket, u.ts)
        stmt = select(
            expr,
            key_expr,
            fold_expr,
            _cost(u),
            _billed_tokens(u),
            _requests(u, status_filter),
            _imported_cost(u),
        ).select_from(rows)
        found = (await self.db.execute(_joined(stmt, spec, with_label=False).group_by(expr, key_expr, fold_expr))).all()
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
            for row in found
        ]
        points.sort(key=lambda p: p.bucket_start)
        return points
