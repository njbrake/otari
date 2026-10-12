from dataclasses import asdict, dataclass
from datetime import datetime
from typing import cast

from gateway.core.series import SERIES_TOP_N, dense_series
from gateway.core.sql import UsageBucketGrain
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import SortOrder, UsageCondition, UsageSort
from gateway.models.usage import UsageLog
from gateway.repositories.usage import UsageReadRepository, UsageSummaryRepository
from gateway.schemas.usage import (
    ActivityGroupBy,
    ActivityGroupOrder,
    BreakdownDimension,
    Bucket,
    SeriesGroupBy,
    SummaryDimension,
    UsageActivityGroup,
    UsageActivityGroups,
    UsageBreakdownRankBy,
    UsageGroupedSeries,
    UsageGroupRow,
    UsageRankBy,
    UsageSeriesGroup,
    UsageSessionRow,
    UsageSummary,
    UsageToolRow,
)
from gateway.services.usage._summary import (
    ALL_SUMMARY_DIMENSIONS,
    BREAKDOWN_TOP_N,
    ERROR_TAXONOMY_DIMENSION,
    GATEWAY_TOOL_NAMES,
    SERIES_BREAKDOWNS,
    SUMMARY_BREAKDOWNS,
    TOOL_DIMENSION,
    empty_usage_point,
    with_fold,
)


@dataclass(frozen=True)
class UsagePageRow:
    """One row of a page of the log, with its display labels and its earlier failed attempts."""

    log: UsageLog
    user_alias: str | None
    api_key_name: str | None
    absorbed_attempts: int


class UsageReadService:
    """The usage log's reads. Each public method is one block of its Unit of Work.

    Each takes the conditions the caller built from the request's filters and its
    tenant scope, so a filter is read one way however the rows are asked for.
    """

    def __init__(self, uow: UnitOfWork, reads: UsageReadRepository, summaries: UsageSummaryRepository) -> None:
        self._uow = uow
        self._reads = reads
        self._summaries = summaries

    async def page(
        self,
        conditions: list[UsageCondition],
        *,
        scope: UsageCondition | None,
        sort: UsageSort,
        order: SortOrder,
        skip: int,
        limit: int,
    ) -> list[UsagePageRow]:
        """A page of rows in the order asked for, each with the attempts its request absorbed.

        ``scope`` is the predicate already in ``conditions``, needed again to count
        the attempts. An absorbed row, and a row outside a routed request, absorbed none.
        """
        async with self._uow:
            rows = await self._reads.usage_rows(conditions, sort=sort, order=order, skip=skip, limit=limit)
            groups = {log.request_group_id for log, _, _ in rows if log.request_group_id and log.status != "absorbed"}
            absorbed = await self._reads.absorbed_attempts(groups, scope)
        return [
            UsagePageRow(
                log=log,
                user_alias=alias,
                api_key_name=key_name,
                absorbed_attempts=0
                if log.status == "absorbed" or log.request_group_id is None
                else absorbed.get(log.request_group_id, 0),
            )
            for log, alias, key_name in rows
        ]

    async def p95_latency_ms(self, conditions: list[UsageCondition]) -> int | None:
        """Nearest-rank 95th-percentile latency over the requests the conditions leave."""
        async with self._uow:
            return await self._reads.p95_latency_ms(conditions)

    async def activity_groups(
        self,
        *,
        group_by: ActivityGroupBy,
        start: datetime,
        end: datetime,
        conditions: list[UsageCondition],
        status: str | None,
        search: str | None,
        order: ActivityGroupOrder,
        skip: int,
        limit: int,
    ) -> UsageActivityGroups:
        """A page of the log's groups over an already-resolved window, and how many groups the filters leave."""
        async with self._uow:
            rows, total = await self._reads.activity_groups(
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
            groups=[UsageActivityGroup.model_validate(row) for row in rows],
        )

    async def summary(
        self,
        *,
        start: datetime,
        end: datetime,
        conditions: list[UsageCondition],
        status: str | None,
        bucket: UsageBucketGrain,
        dimensions: list[SummaryDimension] | None,
        include_p95: bool = False,
        p95_by: BreakdownDimension | None = None,
        session_details: bool = False,
        rank_by: UsageBreakdownRankBy = "cost",
        rank_order: SortOrder = "desc",
    ) -> UsageSummary:
        """Totals, the breakdowns asked for and a zero-filled series, over an already-resolved window.

        Each breakdown is its own ``GROUP BY`` pass, which is why ``dimensions``
        selects them; ``None`` asks for every one. Two extras cost one more grouped
        pass each, and only when the breakdown they decorate is among them: ``p95_by``
        ranks latency per group in that breakdown, and ``session_details`` names the
        source and key most of each session's requests carry. Ranked by ``p95``, every
        breakdown already carries its groups' p95, so ``p95_by`` adds no pass.
        """
        # ``none`` is dropped rather than rejected: it exists only so a caller can send
        # an empty selection, and it never contributes a dimension of its own.
        requested: set[str] = ALL_SUMMARY_DIMENSIONS if dimensions is None else {d for d in dimensions if d != "none"}
        async with self._uow:
            totals = await self._summaries.totals(conditions, status)
            breakdowns = {
                name: with_fold(
                    await self._breakdown(
                        name,
                        conditions,
                        limit=cap,
                        status=status,
                        with_p95=name == p95_by and rank_by != "p95",
                        with_details=session_details,
                        rank_by=rank_by,
                        rank_order=rank_order,
                    ),
                    totals,
                    row_type=UsageSessionRow if name == "source_label" else UsageGroupRow,
                )
                for name, cap in SUMMARY_BREAKDOWNS.items()
                if name in requested
            }
            # Failures only, so the taxonomy is not swamped by the successes that carry
            # no status code; capped rather than folded, since a null key would collide
            # with the real "no code recorded" group.
            errors_by_status_code = (
                await self._summaries.errors_by_status_code(conditions, limit=BREAKDOWN_TOP_N)
                if ERROR_TAXONOMY_DIMENSION in requested
                else []
            )
            by_tool = await self._tool_breakdown(conditions) if TOOL_DIMENSION in requested else []
            if include_p95:
                totals = totals.model_copy(update={"p95_latency_ms": await self._reads.p95_latency_ms(conditions)})
            populated = await self._summaries.series(conditions, status_filter=status, bucket=bucket)
        return UsageSummary(
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            bucket=bucket,
            totals=totals,
            by_model=breakdowns.get("model", []),
            by_user=breakdowns.get("user", []),
            by_api_key=breakdowns.get("api_key", []),
            by_source=breakdowns.get("source", []),
            # Built as session rows, fold included, by ``row_type`` above.
            by_source_label=cast("list[UsageSessionRow]", breakdowns.get("source_label", [])),
            by_endpoint=breakdowns.get("endpoint", []),
            by_provider=breakdowns.get("provider", []),
            by_policy=breakdowns.get("policy", []),
            by_workspace=breakdowns.get("workspace", []),
            by_channel=breakdowns.get("channel", []),
            by_tool=by_tool,
            errors_by_status_code=errors_by_status_code,
            # Zero-filled so the chart is time-linear (GROUP BY drops gaps).
            series=dense_series(start, end, bucket, populated, empty_usage_point),
        )

    async def _breakdown(
        self,
        dimension: BreakdownDimension,
        conditions: list[UsageCondition],
        *,
        limit: int,
        status: str | None,
        with_p95: bool,
        with_details: bool,
        rank_by: UsageBreakdownRankBy,
        rank_order: SortOrder,
    ) -> list[UsageGroupRow]:
        """One breakdown's top groups, with the per-group extras asked for.

        Sessions always carry their span, which their own pass reads; their source and
        key name are the extra pass ``with_details`` asks for.
        """
        is_session = dimension == "source_label"
        rows = await self._summaries.breakdown(
            dimension,
            conditions,
            limit=limit,
            status_filter=status,
            with_span=is_session,
            rank_by=rank_by,
            rank_order=rank_order,
        )
        keys = [row.key for row in rows]
        if with_p95:
            p95 = await self._summaries.group_p95_latency_ms(dimension, keys, conditions)
            rows = [row.model_copy(update={"p95_latency_ms": p95.get(row.key)}) for row in rows]
        if is_session and with_details:
            details = await self._summaries.session_details(keys, conditions, status_filter=status)
            rows = [row.model_copy(update=asdict(details[row.key])) if row.key in details else row for row in rows]
        return rows

    async def _tool_breakdown(self, conditions: list[UsageCondition]) -> list[UsageToolRow]:
        """Per-tool calls, failures, spend and requests, biggest spend first.

        A tool no row ran is left out, so a deployment that never ran one gets an
        empty list and the UI can hide the section entirely.

        ``calls`` and ``errors`` count every call a request made, including calls made by
        an attempt a routing policy later abandoned: the tally is shared across a
        request's attempts and settled onto the row that served, so those calls are on
        that one row rather than spread across the absorbed ones. ``requests`` counts
        requests, so the two answer different questions on purpose: "how much tool work
        did we do" and "how many requests used a tool".
        """
        rows = [await self._summaries.tool_usage(tool, conditions) for tool in GATEWAY_TOOL_NAMES]
        return sorted((row for row in rows if row is not None), key=lambda r: r.cost, reverse=True)

    async def grouped_series(
        self,
        *,
        start: datetime,
        end: datetime,
        conditions: list[UsageCondition],
        status: str | None,
        bucket: Bucket,
        group_by: SeriesGroupBy,
        rank_by: UsageRankBy = "cost",
    ) -> UsageGroupedSeries:
        """The window's top groups by ``rank_by``, each a series of its own, and the rest folded into ``other``."""
        dimension = SERIES_BREAKDOWNS[group_by]
        async with self._uow:
            totals = await self._summaries.totals(conditions, status)
            top = await self._summaries.breakdown(
                dimension, conditions, limit=SERIES_TOP_N, status_filter=status, rank_by=rank_by
            )
            groups = with_fold(
                [UsageSeriesGroup.model_validate(row.model_dump(exclude={"p95_latency_ms"})) for row in top],
                totals,
                row_type=UsageSeriesGroup,
            )
            points = await self._summaries.grouped_series(
                dimension,
                conditions,
                status_filter=status,
                bucket=bucket,
                named={g.key for g in groups if g.key is not None},
                keeps_null=any(g.key is None and not g.is_other for g in groups),
            )
        return UsageGroupedSeries(
            start_date=start.isoformat(),
            end_date=end.isoformat(),
            bucket=bucket,
            group_by=group_by,
            groups=groups,
            points=points,
        )
