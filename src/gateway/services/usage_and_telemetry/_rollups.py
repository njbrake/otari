"""Keep the hourly usage rollups current: rebuild each hour a write marked."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from datetime import UTC, datetime

from gateway.core.database import DATABASE_ERRORS, describe_database_error
from gateway.core.unit_of_work import UnitOfWork
from gateway.log_config import logger
from gateway.repositories.usage_and_telemetry import UsageLogRepository

# Hours one pass rebuilds, in one transaction: about a day of rows, so building
# the history after the rollups first appear never holds a transaction open long.
HOURS_PER_PASS = 24
# The pause between passes while a backlog remains, so building the history
# leaves the database room for the requests it serves meanwhile.
_BACKLOG_PAUSE_SEC = 1.0
# How often a caught-up refresh looks for marked hours. An hour a write marked is
# read from its rows until then, so this trades a rebuild's work against a read's.
_REFRESH_INTERVAL_SEC = 30.0


class UsageRollupService:
    """Rebuild the hours whose usage rows changed since their rollups were built."""

    def __init__(self, uow: UnitOfWork, usage_logs: UsageLogRepository) -> None:
        self._uow = uow
        self._usage_logs = usage_logs

    async def refresh(self, max_hours: int = HOURS_PER_PASS, *, now: datetime | None = None) -> int:
        """Rebuild up to ``max_hours`` marked hours that are over, in one block, and return how many."""
        async with self._uow:
            return await self._usage_logs.refresh_rollups(max_hours, now=now or datetime.now(UTC))

    async def marked_hours(self) -> int:
        """How many distinct hours wait for a refresh."""
        async with self._uow:
            return await self._usage_logs.marked_hours()

    @staticmethod
    async def poll(open_service: Callable[[], AbstractAsyncContextManager[UsageRollupService]]) -> None:
        """Refresh until the task is canceled: straight through a backlog, then every 30 seconds.

        The first pass waits one interval, so it does not compete with startup. An
        error is logged and the next pass tries again.
        """
        await asyncio.sleep(_REFRESH_INTERVAL_SEC)
        while True:
            built = 0
            try:
                async with open_service() as rollups:
                    built = await rollups.refresh()
            except asyncio.CancelledError:
                raise
            except DATABASE_ERRORS as exc:
                logger.warning(
                    "Usage rollup refresh failed: %s; retrying in %ss",
                    describe_database_error(exc),
                    _REFRESH_INTERVAL_SEC,
                )
            except Exception as exc:
                # An escaping error would end this worker, and nothing restarts it.
                logger.warning(
                    "Usage rollup refresh failed (%s); retrying in %ss", type(exc).__name__, _REFRESH_INTERVAL_SEC
                )
            await asyncio.sleep(_BACKLOG_PAUSE_SEC if built == HOURS_PER_PASS else _REFRESH_INTERVAL_SEC)
