"""Each group's p95 on SQLite, which has no ordered-set aggregate, interpolates as PostgreSQL's ``percentile_cont``.

The PostgreSQL arm is pinned by ``tests/integration/test_usage_breakdown_ranking.py``
with the same latencies, so the two engines are held to one answer.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlmodel import SQLModel

import gateway.models  # noqa: F401  (registers every table on the metadata)
from gateway.core.unit_of_work import UnitOfWork
from gateway.models.usage import UsageLog
from gateway.repositories.usage_and_telemetry import UsageFilters, UsageLogRepository, UsageScope

pytestmark = pytest.mark.asyncio

_WORKSPACE = uuid.uuid4()


def _row(model: str, latency_ms: int | None, *, status: str = "success", policy: str | None = None) -> UsageLog:
    return UsageLog(
        id=str(uuid.uuid4()),
        workspace_id=_WORKSPACE,
        timestamp=datetime(2026, 3, 1, tzinfo=UTC),
        model=model,
        provider="openai",
        endpoint="/v1/chat/completions",
        source="gateway",
        status=status,
        cost=Decimal("0.01"),
        latency_ms=latency_ms,
        policy_name=policy,
    )


async def _p95(dimension: str, keys: set[str | None] | None) -> tuple[dict[str | None, int], int | None]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    try:
        async with engine.begin() as conn:
            await conn.run_sync(SQLModel.metadata.create_all)
        async with AsyncSession(engine) as session:
            session.add_all(
                [
                    *(_row("a", latency) for latency in (100, 200, 300, 400)),
                    *(_row("b", latency, policy="fast") for latency in (1000, 2000, 3000)),
                    # Neither an absorbed attempt nor a row without a latency counts.
                    _row("b", 99_999, status="absorbed", policy="fast"),
                    _row("c", None),
                ]
            )
            await session.commit()
            uow = UnitOfWork(session)
            repo = UsageLogRepository(uow)
            scope = UsageScope(workspaces=[_WORKSPACE])
            filters = UsageFilters()
            async with uow:
                grouped = await repo.p95_by_group(filters, scope, dimension=dimension, keys=keys)
                whole = await repo.p95_latency_ms(filters, scope)
            return grouped, whole
    finally:
        await engine.dispose()


async def test_every_group_interpolates_between_ranks() -> None:
    grouped, _ = await _p95("model", None)
    # 0.95 * 3 = 2.85 between 300 and 400; 0.95 * 2 = 1.9 between 2000 and 3000.
    assert grouped == {"a": 385, "b": 2900}


async def test_only_the_named_groups_are_read_and_a_null_key_is_one() -> None:
    grouped, _ = await _p95("policy", {None})
    assert grouped == {None: 385}
    assert (await _p95("model", set()))[0] == {}


async def test_one_group_holding_every_row_agrees_with_the_windows_p95() -> None:
    grouped, whole = await _p95("channel", None)
    assert grouped == {"api": whole}
