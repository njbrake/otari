"""Heavy usage reads take turns, so one dashboard page cannot run them all at once."""

import asyncio
from types import TracebackType
from typing import Any, cast

import pytest

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.usage_and_telemetry_exceptions import UsageReadsBusyError
from gateway.repositories.usage_and_telemetry import UsageFilters, UsageLogRepository, UsageScope
from gateway.services.api_keys import ApiKeyService
from gateway.services.organizations import UserAccess
from gateway.services.usage_and_telemetry import HeavyUsageReads, UsageService

FILTERS = UsageFilters()
SCOPE = cast(UsageScope, object())


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


class _Stop(Exception):
    """Ends a read once it has done the part being counted."""


class _SlowUsageLogs:
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

    async def count_matching(self, filters: Any, scope: Any, *, imported_only: bool) -> int:
        await self._work()
        return 0

    async def totals(self, filters: Any, scope: Any) -> Any:
        await self._work()
        raise _Stop


def _service(gate: HeavyUsageReads, connections: _Counter, running: _Counter) -> UsageService:
    uow = _FakeUnitOfWork(connections)
    # Authentication and scope resolution read on the request's session before the service is called.
    uow.statement()
    return UsageService(
        cast(UnitOfWork, uow),
        cast(UsageLogRepository, _SlowUsageLogs(uow, running)),
        keys=cast(ApiKeyService, object()),
        users=cast(UserAccess, object()),
        heavy_reads=gate,
    )


def test_no_more_heavy_reads_run_at_once_than_the_limit() -> None:
    gate = HeavyUsageReads(2)
    connections, running = _Counter(), _Counter()

    async def main() -> None:
        await asyncio.gather(*(_service(gate, connections, running).count(FILTERS, SCOPE) for _ in range(6)))

    asyncio.run(main())

    assert running.most == 2
    # A read waiting its turn holds no connection, although the request read on its session first.
    assert connections.seen == 2


def test_every_kind_of_heavy_read_shares_the_one_limit() -> None:
    gate = HeavyUsageReads(1)
    connections, running = _Counter(), _Counter()

    async def summary() -> None:
        with pytest.raises(_Stop):
            await _service(gate, connections, running).summary(FILTERS, SCOPE, bucket="day", dimensions=["none"])

    async def grouped_series() -> None:
        with pytest.raises(_Stop):
            await _service(gate, connections, running).grouped_series(FILTERS, SCOPE, bucket="day", group_by="model")

    async def count() -> None:
        await _service(gate, connections, running).count(FILTERS, SCOPE)

    async def main() -> None:
        await asyncio.gather(summary(), count(), grouped_series(), summary(), count())

    asyncio.run(main())

    assert running.most == 1


def test_a_read_that_waits_too_long_is_refused_and_takes_no_turn() -> None:
    gate = HeavyUsageReads(1, wait_s=0.01)
    connections, running = _Counter(), _Counter()

    async def main() -> None:
        async with gate.turn(cast(UnitOfWork, _FakeUnitOfWork(connections))):
            with pytest.raises(UsageReadsBusyError):
                await _service(gate, connections, running).count(FILTERS, SCOPE)
        # The refused read gave back nothing it did not take, so the one turn is free again.
        await _service(gate, connections, running).count(FILTERS, SCOPE)

    asyncio.run(main())

    assert running.most == 1
