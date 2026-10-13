"""Heavy usage reads take turns, so one dashboard page cannot run them all at once."""

import asyncio
from datetime import UTC, datetime
from types import TracebackType
from typing import Any, cast

from gateway.core.unit_of_work import UnitOfWork
from gateway.repositories.usage import UsageReadRepository, UsageSummaryRepository
from gateway.services.usage import UsageReadService

START = datetime(2026, 10, 1, tzinfo=UTC)
END = datetime(2026, 10, 2, tzinfo=UTC)


class _Counter:
    def __init__(self) -> None:
        self.now = 0
        self.most = 0

    def enter(self) -> None:
        self.now += 1
        self.most = max(self.most, self.now)

    def leave(self) -> None:
        self.now -= 1


class _FakeUnitOfWork:
    """Counts the blocks open at once: a block is a transaction holding a connection."""

    def __init__(self, blocks: _Counter) -> None:
        self._blocks = blocks

    async def __aenter__(self) -> "_FakeUnitOfWork":
        self._blocks.enter()
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self._blocks.leave()


class _SlowSummaries:
    """Answers every read after a pause, counting how many are running."""

    def __init__(self, running: _Counter) -> None:
        self._running = running

    async def _work(self) -> None:
        self._running.enter()
        await asyncio.sleep(0.01)
        self._running.leave()

    async def tool_usage(self, tool: str, conditions: list[Any]) -> None:
        await self._work()

    async def totals(self, conditions: list[Any], status: str | None) -> Any:
        await self._work()
        raise _Stop


class _Stop(Exception):
    """Ends a read once it has done the part being counted."""


def _service(gate: asyncio.Semaphore, blocks: _Counter, running: _Counter) -> UsageReadService:
    return UsageReadService(
        cast(UnitOfWork, _FakeUnitOfWork(blocks)),
        cast(UsageReadRepository, object()),
        cast(UsageSummaryRepository, _SlowSummaries(running)),
        gate,
    )


def test_no_more_heavy_reads_run_at_once_than_the_limit() -> None:
    gate = asyncio.Semaphore(2)
    blocks, running = _Counter(), _Counter()
    services = [_service(gate, blocks, running) for _ in range(6)]

    async def main() -> None:
        await asyncio.gather(*(service.tools(conditions=[], start=START, end=END) for service in services))

    asyncio.run(main())

    assert running.most == 2
    # A read waiting its turn has not opened its transaction, so it holds no connection.
    assert blocks.most == 2


def test_every_kind_of_heavy_read_shares_the_one_limit() -> None:
    gate = asyncio.Semaphore(1)
    blocks, running = _Counter(), _Counter()

    async def summary() -> None:
        try:
            await _service(gate, blocks, running).summary(
                conditions=[], status=None, bucket="day", dimensions=["none"], start=START, end=END
            )
        except _Stop:
            pass

    async def tools() -> None:
        await _service(gate, blocks, running).tools(conditions=[], start=START, end=END)

    async def main() -> None:
        await asyncio.gather(summary(), tools(), summary(), tools())

    asyncio.run(main())

    assert running.most == 1
