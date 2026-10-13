"""Keep the hourly usage rollups current: rebuild each hour a write marked."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

from gateway.core.unit_of_work import UnitOfWork
from gateway.log_config import logger
from gateway.repositories.usage import UsageRollupRepository

# Hours one pass rebuilds, each in its own transaction-sized bite: about a day of
# rows, so building the history after the rollups first appear never holds a
# transaction open for long.
HOURS_PER_PASS = 24
# The pause between passes while a backlog remains, so building the history gives
# the database room for the requests it is serving meanwhile.
_BACKLOG_PAUSE_SEC = 1.0


class UsageRollupService:
    """Rebuild the hours whose usage rows changed since their rollups were built."""

    def __init__(self, uow: UnitOfWork, rollups: UsageRollupRepository) -> None:
        self._uow = uow
        self._rollups = rollups

    async def refresh(self, max_hours: int = HOURS_PER_PASS) -> int:
        """Rebuild up to ``max_hours`` marked hours in one transaction, and return how many."""
        async with self._uow:
            return await self._rollups.refresh(max_hours)


async def run_usage_rollup_refresher(
    interval_sec: float, open_service: Callable[[], AbstractAsyncContextManager[UsageRollupService]]
) -> None:
    """Refresh until shutdown: straight through a backlog, then once per ``interval_sec``.

    The first pass waits one interval, so it does not compete with startup.
    """
    await asyncio.sleep(interval_sec)
    while True:
        built = 0
        try:
            async with open_service() as rollups:
                built = await rollups.refresh()
        except asyncio.CancelledError:
            raise
        except Exception:
            # An escaping error would end this worker, and nothing restarts it.
            logger.warning("Usage rollup refresh failed; retrying in %ss", interval_sec, exc_info=True)
        await asyncio.sleep(_BACKLOG_PAUSE_SEC if built == HOURS_PER_PASS else interval_sec)
