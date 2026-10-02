"""Schedule the telemetry retention sweep."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager

from gateway.log_config import logger
from gateway.services.usage._retention import TelemetryRetentionService

# The first pass waits a little after startup so it does not compete with it,
# then the sweep repeats. Days-long windows need nothing tighter.
_FIRST_SWEEP_DELAY_SEC = 300
_SWEEP_INTERVAL_SEC = 6 * 3600


async def run_telemetry_retention_sweeper(
    retention_days: int, open_service: Callable[[], AbstractAsyncContextManager[TelemetryRetentionService]]
) -> None:
    """Sweep until shutdown, retrying a failed pass on the next tick."""
    await asyncio.sleep(_FIRST_SWEEP_DELAY_SEC)
    while True:
        try:
            async with open_service() as retention:
                removed = await retention.sweep(retention_days)
            logger.info(
                "telemetry retention: removed usage=%d agent_telemetry=%d older than %d days",
                removed.usage,
                removed.agent_telemetry,
                retention_days,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            # An escaping error would end this worker, and nothing restarts it.
            logger.warning("Telemetry retention sweep failed; retrying in %ss", _SWEEP_INTERVAL_SEC, exc_info=True)
        await asyncio.sleep(_SWEEP_INTERVAL_SEC)
