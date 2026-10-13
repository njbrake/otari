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
        self.seen = 0

    def enter(self) -> None:
        self.now += 1
        self.most = max(self.most, self.now)

    def leave(self) -> None:
        self.now -= 1

    def sample(self) -> None:
        self.seen = max(self.seen, self.now)


class _FakeUnitOfWork:
    """Holds a connection as the request's session does: from its first statement until its outermost block ends."""

    def __init__(self, connections: _Counter) -> None:
        self.connections = connections
        self._holding = False
        self._depth = 0

    def statement(self) -> None:
        if not self._holding:
            self._holding = True
            self.connections.enter()

    async def __aenter__(self) -> "_FakeUnitOfWork":
        self._depth += 1
        return self

    async def __aexit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self._depth -= 1
        if self._depth == 0 and self._holding:
            self._holding = False
            self.connections.leave()


class _SlowSummaries:
    """Answers every read after a pause, counting how many are running."""

    def __init__(self, uow: _FakeUnitOfWork, running: _Counter) -> None:
        self._uow = uow
        self._running = running

    async def _work(self) -> None:
        self._uow.statement()
        self._running.enter()
        await asyncio.sleep(0.01)
        # The other requests are waiting their turn by now.
        self._uow.connections.sample()
        self._running.leave()

    async def tool_usage(self, tool: str, conditions: list[Any]) -> None:
        await self._work()

    async def totals(self, conditions: list[Any], status: str | None) -> Any:
        await self._work()
        raise _Stop


class _Stop(Exception):
    """Ends a read once it has done the part being counted."""


def _service(gate: asyncio.Semaphore, connections: _Counter, running: _Counter) -> UsageReadService:
    uow = _FakeUnitOfWork(connections)
    # Authentication and scope resolution read on the request's session before the service is called.
    uow.statement()
    return UsageReadService(
        cast(UnitOfWork, uow),
        cast(UsageReadRepository, object()),
        cast(UsageSummaryRepository, _SlowSummaries(uow, running)),
        gate,
    )


def test_no_more_heavy_reads_run_at_once_than_the_limit() -> None:
    gate = asyncio.Semaphore(2)
    connections, running = _Counter(), _Counter()

    async def main() -> None:
        await asyncio.gather(
            *(_service(gate, connections, running).tools(conditions=[], start=START, end=END) for _ in range(6))
        )

    asyncio.run(main())

    assert running.most == 2
    # A read waiting its turn holds no connection, although the request read on its session first.
    assert connections.seen == 2


def test_every_kind_of_heavy_read_shares_the_one_limit() -> None:
    gate = asyncio.Semaphore(1)
    connections, running = _Counter(), _Counter()

    async def summary() -> None:
        try:
            await _service(gate, connections, running).summary(
                conditions=[], status=None, bucket="day", dimensions=["none"], start=START, end=END
            )
        except _Stop:
            pass

    async def tools() -> None:
        await _service(gate, connections, running).tools(conditions=[], start=START, end=END)

    async def main() -> None:
        await asyncio.gather(summary(), tools(), summary(), tools())

    asyncio.run(main())

    assert running.most == 1
