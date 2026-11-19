"""Delete imported usage and agent telemetry once it is older than the retention window.

Coding-agent telemetry arrives far faster than the gateway's own traffic, and
nothing else ever removes it. Usage the gateway served is the billing record
and is kept.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from gateway.core.database import DATABASE_ERRORS, describe_database_error
from gateway.core.unit_of_work import UnitOfWork
from gateway.log_config import logger
from gateway.ports.telemetry_storage_port import TelemetryFilter, TelemetryStoragePort
from gateway.repositories.usage_and_telemetry import UsageLogRepository

# Rows per DELETE, so one statement never holds usage_logs for long.
_BATCH_SIZE = 5000

# The first pass waits a little after startup so it does not compete with it,
# then the sweep repeats. Days-long windows need nothing tighter.
_FIRST_SWEEP_DELAY_SEC = 300
_SWEEP_INTERVAL_SEC = 6 * 3600


@dataclass(frozen=True)
class RetentionSweep:
    """Rows one sweep removed."""

    usage: int
    agent_telemetry: int


class TelemetryRetentionService:
    """Delete what is past the retention window."""

    def __init__(self, uow: UnitOfWork, usage_logs: UsageLogRepository, storage: TelemetryStoragePort) -> None:
        self._uow = uow
        self._usage_logs = usage_logs
        self._storage = storage

    async def sweep(
        self, retention_days: int, *, now: datetime | None = None, batch_size: int = _BATCH_SIZE
    ) -> RetentionSweep:
        """Delete imported usage and agent telemetry older than ``retention_days``, a batch per block."""
        cutoff = (now or datetime.now(UTC)) - timedelta(days=retention_days)
        usage = 0
        while True:
            async with self._uow:
                removed = await self._usage_logs.delete_imported_before(cutoff, limit=batch_size)
            usage += removed
            if removed < batch_size:
                break
        agent_telemetry = await self._storage.purge(ids=(), filters=TelemetryFilter(end=cutoff))
        return RetentionSweep(usage=usage, agent_telemetry=agent_telemetry)

    @staticmethod
    async def poll(
        retention_days: int, open_service: Callable[[], AbstractAsyncContextManager["TelemetryRetentionService"]]
    ) -> None:
        """Sweep every six hours, until the task is canceled; an error is logged and the next pass tries again."""
        await asyncio.sleep(_FIRST_SWEEP_DELAY_SEC)
        while True:
            try:
                async with open_service() as retention:
                    removed = await retention.sweep(retention_days)
                logger.info(
                    "Telemetry retention removed usage=%d agent_telemetry=%d older than %d days",
                    removed.usage,
                    removed.agent_telemetry,
                    retention_days,
                )
            except asyncio.CancelledError:
                raise
            except DATABASE_ERRORS as exc:
                logger.warning(
                    "Telemetry retention sweep failed: %s; retrying in %ss",
                    describe_database_error(exc),
                    _SWEEP_INTERVAL_SEC,
                )
            except Exception as exc:
                # An escaping error would end this worker, and nothing restarts it.
                logger.warning(
                    "Telemetry retention sweep failed (%s); retrying in %ss", type(exc).__name__, _SWEEP_INTERVAL_SEC
                )
            await asyncio.sleep(_SWEEP_INTERVAL_SEC)
