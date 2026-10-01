"""The usage aggregates that take a SQLite-specific path, run on SQLite.

The integration suite migrates PostgreSQL only, and three of the Activity read
features are written twice, once per dialect: the five-minute bucket (``date_bin``
against an epoch floor), the 95th-percentile latency (``percentile_disc`` against an
ordered offset) and the search's ``LIKE`` escaping. SQLite is the engine the OSS
edition ships by default, so its half is asserted here against the answers the
PostgreSQL tests expect.
"""

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlmodel import SQLModel

import gateway.models  # noqa: F401  (registers every table on the shared metadata)
from gateway.core.sql import bucket_expr, canonical_bucket
from gateway.core.usage_filters import usage_search_condition
from gateway.models.usage import UsageLog
from gateway.repositories.usage.usage_read_repository import p95_latency_ms

T0 = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
WORKSPACE = uuid.uuid4()


def _run[T](body: Callable[[AsyncSession], Awaitable[T]]) -> T:
    async def main() -> T:
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        try:
            async with engine.begin() as conn:
                await conn.run_sync(SQLModel.metadata.create_all)
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                return await body(session)
        finally:
            await engine.dispose()

    return asyncio.run(main())


def _log(**overrides: object) -> UsageLog:
    fields: dict[str, object] = {
        "id": str(uuid.uuid4()),
        "workspace_id": WORKSPACE,
        "timestamp": T0,
        "model": "claude-haiku-4-5",
        "provider": "anthropic",
        "endpoint": "/v1/messages",
        "status": "success",
    }
    fields.update(overrides)
    return UsageLog(**fields)


def test_five_minute_buckets_land_on_the_five_minute_grid() -> None:
    async def body(db: AsyncSession) -> list[tuple[str, int]]:
        db.add_all(
            [
                _log(timestamp=T0 + timedelta(minutes=1)),
                _log(timestamp=T0 + timedelta(minutes=4, seconds=59)),
                _log(timestamp=T0 + timedelta(minutes=5)),
                _log(timestamp=T0 + timedelta(minutes=12)),
            ]
        )
        await db.commit()
        expr = bucket_expr("sqlite", "5min", UsageLog.timestamp)
        rows = (await db.execute(select(expr, func.count()).group_by(expr).order_by(expr))).all()
        return [(canonical_bucket(key, "5min"), int(count)) for key, count in rows]

    assert _run(body) == [
        ("2026-07-01T09:00:00Z", 2),
        ("2026-07-01T09:05:00Z", 1),
        ("2026-07-01T09:10:00Z", 1),
    ]


def test_p95_is_the_nearest_rank_value_postgres_returns() -> None:
    async def body(db: AsyncSession) -> int | None:
        db.add_all([_log(latency_ms=i * 100) for i in range(1, 21)])
        db.add(_log(status="absorbed", latency_ms=99_999))
        db.add(_log(latency_ms=None))
        await db.commit()
        return await p95_latency_ms(db, [])

    assert _run(body) == 1900


def test_p95_of_nothing_is_null() -> None:
    async def body(db: AsyncSession) -> int | None:
        return await p95_latency_ms(db, [])

    assert _run(body) is None


def test_search_treats_like_wildcards_as_text() -> None:
    async def body(db: AsyncSession) -> set[str]:
        db.add_all([_log(id="underscore", model="gpt_4"), _log(id="bait", model="gptx4")])
        await db.commit()
        condition = usage_search_condition("GPT_4")
        assert condition is not None
        return set((await db.execute(select(UsageLog.id).where(condition))).scalars())

    assert _run(body) == {"underscore"}
