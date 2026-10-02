"""Delete imported usage and agent telemetry once it is older than the retention window.

Coding-agent telemetry arrives far faster than the gateway's own traffic, and
nothing else ever removes it. Usage the gateway served is the billing record
and is kept.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from gateway.core.unit_of_work import UnitOfWork
from gateway.ports.telemetry_storage_port import TelemetryFilter, TelemetryStoragePort
from gateway.repositories.usage import UsageRetentionRepository

# Rows per DELETE, so one statement never holds usage_logs for long.
_BATCH_SIZE = 5000


@dataclass(frozen=True)
class RetentionSweep:
    """Rows one sweep removed."""

    usage: int
    agent_telemetry: int


class TelemetryRetentionService:
    """Delete what is past the retention window."""

    def __init__(self, uow: UnitOfWork, usage_logs: UsageRetentionRepository, storage: TelemetryStoragePort) -> None:
        self._uow = uow
        self._usage_logs = usage_logs
        self._storage = storage

    async def sweep(
        self, retention_days: int, *, now: datetime | None = None, batch_size: int = _BATCH_SIZE
    ) -> RetentionSweep:
        """Delete imported usage and agent telemetry older than ``retention_days``."""
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
