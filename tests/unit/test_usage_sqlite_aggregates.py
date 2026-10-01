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
from gateway.api.routes.usage import _activity_groups_response
from gateway.core.sql import bucket_expr, canonical_bucket
from gateway.core.usage_filters import SortOrder, UsageRefinements, refinement_conditions, usage_search_condition
from gateway.models.usage import UsageLog
from gateway.repositories.usage.usage_read_repository import _group_models, _ordering, p95_latency_ms

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


def test_a_sort_puts_rows_without_a_value_last_in_both_directions() -> None:
    async def body(db: AsyncSession) -> tuple[list[str], list[str]]:
        db.add_all(
            [
                _log(id="cheap", cost=0.01, timestamp=T0),
                _log(id="unpriced", cost=None, timestamp=T0 + timedelta(minutes=1)),
                _log(id="dear", cost=0.9, timestamp=T0 + timedelta(minutes=2)),
            ]
        )
        await db.commit()

        async def ids(order: SortOrder) -> list[str]:
            stmt = select(UsageLog.id).order_by(*_ordering("cost", order))
            return list((await db.execute(stmt)).scalars())

        return await ids("desc"), await ids("asc")

    assert _run(body) == (["dear", "cheap", "unpriced"], ["cheap", "dear", "unpriced"])


def test_an_exclusion_keeps_the_rows_with_no_value() -> None:
    async def body(db: AsyncSession) -> set[str]:
        db.add_all([_log(id="priya", user_id="u-priya"), _log(id="nobody", user_id=None)])
        await db.commit()
        conditions = refinement_conditions(UsageRefinements(exclude_user_id=["u-priya"]))
        return set((await db.execute(select(UsageLog.id).where(*conditions))).scalars())

    assert _run(body) == {"nobody"}


def test_activity_groups_aggregate_on_sqlite() -> None:
    async def body(db: AsyncSession) -> list[tuple[str | None, int, int, str, str, list[str]]]:
        db.add_all(
            [
                _log(model="a", source_label="s1", latency_ms=100, timestamp=T0),
                _log(model="b", source_label="s1", latency_ms=200, timestamp=T0 + timedelta(minutes=5)),
                _log(model="b", source_label="s1", status="absorbed", latency_ms=999, timestamp=T0),
                _log(model="a", source_label=None, latency_ms=50, timestamp=T0 + timedelta(minutes=1)),
            ]
        )
        await db.commit()
        page = await _activity_groups_response(
            db,
            group_by="source_label",
            start=T0,
            end=T0 + timedelta(hours=1),
            conditions=[],
            status=None,
            search=None,
            order="recent",
            skip=0,
            limit=10,
        )
        return [(g.key, g.requests, g.latency_ms, g.first_at, g.last_at, g.models) for g in page.groups]

    assert _run(body) == [
        ("s1", 2, 300, "2026-07-01T09:00:00+00:00", "2026-07-01T09:05:00+00:00", ["a", "b"]),
        (None, 1, 50, "2026-07-01T09:01:00+00:00", "2026-07-01T09:01:00+00:00", ["a"]),
    ]


def test_a_page_with_no_groups_names_no_models() -> None:
    """An empty page asks nothing: with no keys to match, the query would group the whole window."""

    async def body(db: AsyncSession) -> dict[str | None, tuple[list[str], int]]:
        db.add(_log(model="a"))
        await db.commit()
        return await _group_models(db, UsageLog.api_key_id, [], [], None)

    assert _run(body) == {}
