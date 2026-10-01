from dataclasses import dataclass

from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import SortOrder, UsageCondition, UsageSort
from gateway.models.usage import UsageLog
from gateway.repositories.usage import ActivityGroupRow, UsageReadRepository
from gateway.schemas.usage import ActivityGroupBy, ActivityGroupOrder


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

    def __init__(self, uow: UnitOfWork, reads: UsageReadRepository) -> None:
        self._uow = uow
        self._reads = reads

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
        conditions: list[UsageCondition],
        status: str | None,
        search: str | None,
        order: ActivityGroupOrder,
        skip: int,
        limit: int,
    ) -> tuple[list[ActivityGroupRow], int]:
        """A page of the log's groups, and how many groups the filters leave."""
        async with self._uow:
            return await self._reads.activity_groups(
                group_by=group_by,
                conditions=conditions,
                status=status,
                search=search,
                order=order,
                skip=skip,
                limit=limit,
            )
