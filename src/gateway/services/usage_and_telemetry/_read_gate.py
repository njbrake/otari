"""The turns a worker's heavy usage reads take, so one dashboard page cannot run them all at once."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.usage_and_telemetry_exceptions import UsageReadsBusyError

# How long a heavy read waits for its turn before the caller is told to come back.
# A dashboard page that has waited this long has usually been left or reloaded, and
# a read nobody is waiting for should not keep its place in the queue.
HEAVY_READ_WAIT_S = 30.0


class HeavyUsageReads:
    """The gate every heavy usage read one worker serves takes a turn at.

    A dashboard page asks for several aggregates at once, and each can sort or
    group every usage row in a long window, so running them all together is
    what runs a small database out of memory; the gate admits ``limit`` at once.
    """

    def __init__(self, limit: int, *, wait_s: float = HEAVY_READ_WAIT_S) -> None:
        self.limit = limit
        self._gate = asyncio.Semaphore(limit)
        self._wait_s = wait_s

    @asynccontextmanager
    async def turn(self, uow: UnitOfWork) -> AsyncIterator[None]:
        """Hold one turn for the body.

        Authentication and scope resolution have already read on the request's
        session, and its transaction holds a pooled connection until something
        ends it. The empty block ends it first, so a read waiting its turn holds
        no connection. A read that waits past ``wait_s`` is refused rather than
        queued for good.

        Raises:
            UsageReadsBusyError: no turn came free in time.
        """
        async with uow:
            pass
        try:
            async with asyncio.timeout(self._wait_s):
                await self._gate.acquire()
        except TimeoutError:
            raise UsageReadsBusyError from None
        try:
            yield
        finally:
            self._gate.release()
