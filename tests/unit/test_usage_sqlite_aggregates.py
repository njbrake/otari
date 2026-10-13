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
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import SortOrder, UsageRefinements, refinement_conditions, usage_search_condition
from gateway.models.usage import UsageLog
from gateway.repositories.usage import UsageReadRepository, UsageSummaryRepository
from gateway.repositories.usage.usage_read_repository import _ordering
from gateway.services.usage import UsageReadService

T0 = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
WORKSPACE = uuid.uuid4()


def _reads(db: AsyncSession) -> UsageReadService:
    uow = UnitOfWork(db)
    return UsageReadService(uow, UsageReadRepository(uow), UsageSummaryRepository(uow), asyncio.Semaphore(2))


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
        return await _reads(db).p95_latency_ms([])

    assert _run(body) == 1900


def test_p95_of_nothing_is_null() -> None:
    async def body(db: AsyncSession) -> int | None:
        return await _reads(db).p95_latency_ms([])

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
        page = await _reads(db).activity_groups(
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
        uow = UnitOfWork(db)
        async with uow:
            return await UsageReadRepository(uow)._group_models(UsageLog.api_key_id, [], [], None)

    assert _run(body) == {}


def test_a_groups_p95_on_sqlite_is_the_nearest_rank_value_postgresql_returns() -> None:
    async def body(db: AsyncSession) -> dict[str | None, int]:
        db.add_all(
            [*(_log(model="steady", latency_ms=ms) for ms in range(100, 2100, 100))]
            + [
                _log(model="steady", latency_ms=90_000, status="absorbed"),
                _log(model="once", latency_ms=700),
                _log(model="unmeasured"),
            ]
        )
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            return await UsageSummaryRepository(uow).group_p95_latency_ms("model", ["steady", "once", "unmeasured"], [])

    assert _run(body) == {"steady": 1900, "once": 700}


def test_the_channel_breakdown_on_sqlite_tells_the_three_channels_apart() -> None:
    from gateway.models.api_keys import APIKey
    from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT

    async def body(db: AsyncSession) -> dict[str | None, int]:
        db.add(APIKey(id="k-forward", key_hash="h", key_name="forward", workspace_id=WORKSPACE, internal_secret="s"))
        db.add_all(
            [
                _log(source="claude_code"),
                _log(source="gateway", endpoint=PLAYGROUND_USAGE_ENDPOINT),
                _log(source="gateway", api_key_id="k-forward"),
                _log(source="gateway"),
                _log(source="gateway"),
            ]
        )
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            rows = await UsageSummaryRepository(uow).breakdown("channel", [], limit=None)
        return {row.key: row.requests for row in rows}

    assert _run(body) == {"imported": 1, "playground": 2, "api": 2}


def _p95_fixture(db: AsyncSession) -> None:
    """Policies ``slow`` p95 900, ``fast`` 100, ``mid`` 400 (an absorbed attempt left out), ``blind`` none, none 400."""
    db.add_all(
        [
            _log(policy_name="slow", latency_ms=900),
            _log(policy_name="fast", latency_ms=100),
            _log(policy_name="mid", latency_ms=400),
            _log(policy_name="mid", latency_ms=90_000, status="absorbed"),
            _log(policy_name="blind"),
            _log(latency_ms=400),
        ]
    )


def test_ranking_by_p95_on_sqlite_orders_as_postgresql_does() -> None:
    async def body(db: AsyncSession) -> dict[str, list[tuple[str | None, int | None]]]:
        _p95_fixture(db)
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            repo = UsageSummaryRepository(uow)
            ranked = {}
            for order in ("desc", "asc"):
                rows = await repo.breakdown("policy", [], limit=None, rank_by="p95", rank_order=order)
                ranked[order] = [(row.key, row.p95_latency_ms) for row in rows]
            # The limit applies after the ranking, so it keeps the slowest.
            rows = await repo.breakdown("policy", [], limit=2, rank_by="p95")
            ranked["top"] = [(row.key, row.p95_latency_ms) for row in rows]
        return ranked

    # The unrouted group ties with ``mid`` and comes after it; ``blind`` has nothing to rank.
    assert _run(body) == {
        "desc": [("slow", 900), ("mid", 400), (None, 400), ("fast", 100), ("blind", None)],
        "asc": [("fast", 100), ("mid", 400), (None, 400), ("slow", 900), ("blind", None)],
        "top": [("slow", 900), ("mid", 400)],
    }


def test_ranking_sessions_by_p95_on_sqlite_keeps_their_span() -> None:
    async def body(db: AsyncSession) -> list[tuple[str | None, int | None, datetime | None]]:
        db.add_all(
            [
                _log(source_label="s-fast", latency_ms=100, timestamp=T0),
                _log(source_label="s-slow", latency_ms=800, timestamp=T0 + timedelta(minutes=3)),
            ]
        )
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            rows = await UsageSummaryRepository(uow).breakdown(
                "source_label", [], limit=None, with_span=True, rank_by="p95"
            )
        return [(row.key, row.p95_latency_ms, getattr(row, "first_at", None)) for row in rows]

    assert _run(body) == [("s-slow", 800, T0 + timedelta(minutes=3)), ("s-fast", 100, T0)]


def test_ranking_by_name_on_sqlite_reads_the_label_and_ignores_case() -> None:
    from gateway.models.api_keys import APIKey

    async def body(db: AsyncSession) -> dict[str, list[str | None]]:
        db.add(APIKey(id="k-a", key_hash="ha", key_name="zebra", workspace_id=WORKSPACE))
        db.add(APIKey(id="k-b", key_hash="hb", key_name="Apple", workspace_id=WORKSPACE))
        db.add(APIKey(id="k-c", key_hash="hc", key_name="mango", workspace_id=WORKSPACE))
        db.add_all([_log(api_key_id="k-a"), _log(api_key_id="k-b"), _log(api_key_id="k-c"), _log()])
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            repo = UsageSummaryRepository(uow)
            orders: tuple[SortOrder, ...] = ("asc", "desc")
            return {
                order: [
                    row.key for row in await repo.breakdown("api_key", [], limit=None, rank_by="name", rank_order=order)
                ]
                for order in orders
            }

    assert _run(body) == {"asc": ["k-b", "k-c", "k-a", None], "desc": ["k-a", "k-c", "k-b", None]}


def test_ranking_by_failures_on_sqlite_brings_a_cheap_group_into_the_top_n() -> None:
    async def body(db: AsyncSession) -> tuple[list[str | None], list[str | None]]:
        db.add_all([_log(model="dear", cost=5.0), _log(model="flaky", status="error"), _log(model="cheap", cost=0.1)])
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            repo = UsageSummaryRepository(uow)
            by_cost = await repo.breakdown("model", [], limit=1)
            by_errors = await repo.breakdown("model", [], limit=1, rank_by="errors")
        return [row.key for row in by_cost], [row.key for row in by_errors]

    assert _run(body) == (["dear"], ["flaky"])


def test_a_groups_p95_on_sqlite_by_channel_and_by_workspace() -> None:
    """The channel is a CASE over a joined key and the workspace a UUID column, both partitioned and read back."""
    from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT

    other = uuid.uuid4()

    async def body(db: AsyncSession) -> tuple[dict[str | None, int], dict[str | None, int]]:
        db.add_all(
            [
                _log(source="claude_code", latency_ms=700),
                _log(endpoint=PLAYGROUND_USAGE_ENDPOINT, latency_ms=300),
                _log(latency_ms=100),
                _log(latency_ms=200, workspace_id=other),
            ]
        )
        await db.commit()
        uow = UnitOfWork(db)
        async with uow:
            repo = UsageSummaryRepository(uow)
            channels = await repo.group_p95_latency_ms("channel", ["imported", "playground", "api"], [])
            workspaces = await repo.group_p95_latency_ms("workspace", [str(WORKSPACE), str(other)], [])
        return channels, workspaces

    channels, workspaces = _run(body)
    assert channels == {"imported": 700, "playground": 300, "api": 200}
    assert workspaces == {str(WORKSPACE): 700, str(other): 200}


def test_the_summary_on_sqlite_ranks_by_p95_and_fills_p95_by_once() -> None:
    async def body(db: AsyncSession) -> list[tuple[str | None, int | None, bool]]:
        _p95_fixture(db)
        await db.commit()
        summary = await _reads(db).summary(
            start=T0 - timedelta(hours=1),
            end=T0 + timedelta(hours=1),
            conditions=[],
            status=None,
            bucket="day",
            dimensions=["policy"],
            p95_by="policy",
            rank_by="p95",
            rank_order="asc",
        )
        return [(row.key, row.p95_latency_ms, row.is_other) for row in summary.by_policy]

    assert _run(body) == [
        ("fast", 100, False),
        ("mid", 400, False),
        (None, 400, False),
        ("slow", 900, False),
        ("blind", None, False),
    ]


def test_the_channel_filter_on_sqlite_classifies_rows_as_the_breakdown_does() -> None:
    from gateway.models.api_keys import APIKey
    from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT

    async def body(db: AsyncSession) -> dict[str, set[str]]:
        db.add(APIKey(id="k-forward", key_hash="hf", key_name="forward", workspace_id=WORKSPACE, internal_secret="s"))
        db.add(APIKey(id="k-app", key_hash="ha", key_name="app", workspace_id=WORKSPACE))
        db.add_all(
            [
                _log(id="imported", source="claude_code"),
                # Imported under a minted key is still imported: the source decides first.
                _log(id="imported-keyed", source="claude_code", api_key_id="k-forward"),
                _log(id="typed", source="gateway", endpoint=PLAYGROUND_USAGE_ENDPOINT),
                _log(id="forwarded", source="gateway", api_key_id="k-forward"),
                _log(id="api-keyed", source="gateway", api_key_id="k-app"),
                _log(id="api-keyless", source="gateway"),
            ]
        )
        await db.commit()

        async def ids(**refine: object) -> set[str]:
            conditions = refinement_conditions(UsageRefinements.model_validate(refine))
            return set((await db.execute(select(UsageLog.id).where(*conditions))).scalars())

        return {
            "imported": await ids(channel="imported"),
            "playground": await ids(channel="playground"),
            "api": await ids(channel="api"),
            "not-api": await ids(exclude_channel="api"),
            "not-playground": await ids(exclude_channel=["playground"]),
        }

    assert _run(body) == {
        "imported": {"imported", "imported-keyed"},
        "playground": {"typed", "forwarded"},
        "api": {"api-keyed", "api-keyless"},
        "not-api": {"imported", "imported-keyed", "typed", "forwarded"},
        "not-playground": {"imported", "imported-keyed", "api-keyed", "api-keyless"},
    }


def test_the_most_common_value_breaks_a_tie_toward_a_named_value_then_by_name() -> None:
    from collections import Counter

    from gateway.repositories.usage.usage_summary_repository import _most_common

    assert _most_common(Counter({"b": 2, "a": 2, None: 2})) == "a"
    assert _most_common(Counter({None: 2, "z": 2})) == "z"
    assert _most_common(Counter({None: 3, "a": 1})) is None
    assert _most_common(Counter({"codex": 1, "claude_code": 2})) == "claude_code"
