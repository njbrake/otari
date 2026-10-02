"""Data access for the usage rows the retention sweep deletes."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any, Never, cast

from sqlalchemy import delete, select

from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_source import not_served_here
from gateway.models.usage import UsageLog
from gateway.repositories.base_repository import BaseRepository

if TYPE_CHECKING:
    from sqlalchemy.engine import CursorResult


class UsageRetentionRepository(BaseRepository[UsageLog, Never, Never]):
    """Query and delete usage rows in the open block of a Unit of Work."""

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, UsageLog)

    async def delete_imported_before(self, cutoff: datetime, *, limit: int) -> int:
        """Delete up to ``limit`` imported rows older than ``cutoff``; return how many went.

        Imported means this deployment did not serve the request and it never
        counted toward a budget, so a row the gateway served is never matched.
        """
        expired = (
            select(UsageLog.id)
            .where(
                UsageLog.timestamp < cutoff,
                not_served_here(UsageLog.source),
                UsageLog.counts_toward_budget.is_(False),
            )
            .limit(limit)
        )
        result = cast("CursorResult[Any]", await self.db.execute(delete(UsageLog).where(UsageLog.id.in_(expired))))
        return result.rowcount or 0
