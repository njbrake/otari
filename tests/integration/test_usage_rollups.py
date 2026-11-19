"""The hourly usage rollups answer every aggregate read the way the rows do.

Runs against PostgreSQL, the one engine whose triggers mark the hours a write
changed. Each parity check runs the same read through a repository that takes
whole hours from the rollups and through one that reads only the rows, over
randomized rows and windows whose bounds fall inside an hour, and requires the
two answers to be equal.
"""

from __future__ import annotations

import random
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from conftest import seed_workspace_id
from gateway.core.unit_of_work import UnitOfWork
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog, UsageRollup, UsageRollupDirtyHour
from gateway.models.users import User
from gateway.repositories.usage_and_telemetry import (
    UsageFilters,
    UsageLogRepository,
    UsageRefinements,
    UsageScope,
)
from gateway.repositories.usage_and_telemetry.usage_log_repository import MAX_MARKED_HOURS
from gateway.schemas.usage_and_telemetry import GATEWAY_TOOL_NAMES, Bucket
from gateway.services.usage_and_telemetry import UsageRollupService

# Every hour the rows fall in is over by then, so a refresh builds them all.
_FAR_FUTURE = datetime(2100, 1, 1, tzinfo=UTC)
_BASE = datetime(2026, 3, 1, tzinfo=UTC)
_HOURS = 40

_USERS = ("u1", "u2", None)
_KEYS = ("k1", "k2", None)
_MODELS = ("gpt-4o", "claude-sonnet", "openai/gpt-4o")
_PROVIDERS = ("openai", "anthropic", None)
_ENDPOINTS = ("/v1/chat/completions", "/v1/messages")
_SOURCES = ("gateway", "claude-code")
_LABELS = (None, "session-a", "session-b")
_STATUSES = ("success", "success", "success", "error", "absorbed", "incomplete")
_POLICIES = (None, None, "fast", "cheap")


def _meters(rng: random.Random) -> dict[str, Any] | None:
    roll = rng.random()
    if roll < 0.3:
        return None
    meters: dict[str, Any] = {
        "total_input_tokens": rng.randint(0, 5000),
        "completion_tokens": rng.randint(0, 2000),
    }
    if rng.random() < 0.5:
        meters["cache_read_tokens"] = rng.randint(0, 1000)
    if rng.random() < 0.3:
        meters["cache_write_tokens"] = rng.randint(0, 500)
    if rng.random() < 0.15:
        # Tool-only charge on a row whose tokens were never metered: it still needs pricing.
        del meters["total_input_tokens"]
    if rng.random() < 0.4:
        tool = rng.choice(GATEWAY_TOOL_NAMES)
        meters["tools"] = {
            tool: {
                "billed": rng.randint(0, 4),
                "errors": rng.randint(0, 2),
                "unit_rate": rng.choice([0.01, 0.005, 0.0125]),
            }
        }
    return meters


def _row(rng: random.Random, workspace_id: uuid.UUID, timestamp: datetime) -> UsageLog:
    status = rng.choice(_STATUSES)
    prompt = rng.choice([None, rng.randint(0, 5000)])
    completion = rng.choice([None, rng.randint(0, 2000)])
    return UsageLog(
        id=str(uuid.uuid4()),
        timestamp=timestamp,
        workspace_id=workspace_id,
        user_id=rng.choice(_USERS),
        api_key_id=rng.choice(_KEYS),
        model=rng.choice(_MODELS),
        provider=rng.choice(_PROVIDERS),
        endpoint=rng.choice(_ENDPOINTS),
        source=rng.choice(_SOURCES),
        source_label=rng.choice(_LABELS),
        tags={"team": rng.choice(["a", "b"])} if rng.random() < 0.5 else None,
        status=status,
        status_code=rng.choice([429, 500, 502, None]) if status == "error" else None,
        counts_toward_budget=rng.random() < 0.8,
        cost=rng.choice([None, Decimal(rng.randint(0, 2_000_000)) / Decimal(1_000_000)]),
        prompt_tokens=prompt,
        completion_tokens=completion,
        total_tokens=(prompt or 0) + (completion or 0) if prompt is not None else None,
        cache_read_tokens=rng.choice([None, rng.randint(0, 800)]),
        cache_write_tokens=rng.choice([None, rng.randint(0, 300)]),
        cache_write_1h_tokens=rng.choice([None, rng.randint(0, 100)]),
        reasoning_tokens=rng.choice([None, rng.randint(0, 400)]),
        billing_meters=_meters(rng),
        latency_ms=rng.choice([None, rng.randint(5, 30_000)]),
        request_group_id=str(uuid.uuid4()),
        policy_name=rng.choice(_POLICIES),
    )


def _rows(rng: random.Random, workspace_id: uuid.UUID, count: int) -> list[UsageLog]:
    return [_row(rng, workspace_id, _BASE + timedelta(seconds=rng.randint(0, _HOURS * 3600 - 1))) for _ in range(count)]


def _seed_identities(db: Session, workspace_id: uuid.UUID) -> None:
    for user_id in ("u1", "u2"):
        db.add(User(user_id=user_id, alias=user_id, spend=0.0, blocked=False))
    db.flush()
    for key_id, user_id in (("k1", "u1"), ("k2", "u2")):
        db.add(
            APIKey(id=key_id, key_hash=f"hash-{key_id}", key_name=key_id, user_id=user_id, workspace_id=workspace_id)
        )
    db.flush()


class _Reader:
    """Usage reads on one session, each in a block of its own, from the rollups or from the rows alone."""

    def __init__(self, uow: UnitOfWork, *, rollups: bool) -> None:
        self.uow = uow
        self.repo = UsageLogRepository(uow, rollups=rollups)


@pytest_asyncio.fixture
async def sessions(async_db: AsyncSession) -> AsyncIterator[tuple[_Reader, _Reader]]:
    """A reader that takes whole hours from the rollups and one that reads only the rows."""
    uow = UnitOfWork(async_db)
    yield _Reader(uow, rollups=True), _Reader(uow, rollups=False)


def _service(async_db: AsyncSession) -> UsageRollupService:
    uow = UnitOfWork(async_db)
    return UsageRollupService(uow, UsageLogRepository(uow))


async def _refresh_all(async_db: AsyncSession) -> int:
    service = _service(async_db)
    built = 0
    while hours := await service.refresh(now=_FAR_FUTURE):
        built += hours
    return built


def _windows(rng: random.Random) -> list[tuple[datetime | None, datetime | None]]:
    """Windows with bounds inside an hour, on an hour, open on one side, and inside one hour."""
    windows: list[tuple[datetime | None, datetime | None]] = [
        (_BASE + timedelta(hours=2), _BASE + timedelta(hours=30)),
        (None, None),
        (_BASE + timedelta(hours=5, minutes=17), None),
        (None, _BASE + timedelta(hours=20, minutes=44)),
        (_BASE + timedelta(hours=7, minutes=10), _BASE + timedelta(hours=7, minutes=50)),
        # A naive bound reads as UTC, and an offset of half an hour has hours of its own.
        (datetime(2026, 3, 1, 3, 30), datetime(2026, 3, 2, 14, 45, 1, tzinfo=timezone(timedelta(hours=5, minutes=30)))),
    ]
    for _ in range(2):
        start = _BASE + timedelta(seconds=rng.randint(0, _HOURS * 3600 // 2))
        windows.append((start, start + timedelta(seconds=rng.randint(60, _HOURS * 3600 // 2))))
    return windows


_FILTERS: list[dict[str, Any]] = [
    {},
    {"user_id": ["u1"]},
    {"user_id": ["u1", "u2"], "model": ["gpt-4o", "openai/gpt-4o"]},
    {"status": "error"},
    {"status": "absorbed"},
    {"status_code": 429},
    {"provider": "openai", "endpoint": "/v1/messages"},
    {"source": "claude-code", "source_label": "session-a"},
    {"api_key_id": ["k2"]},
    {"priced": True},
    {"priced": False},
    {"counts_toward_budget": False},
    # Filters the rollups cannot serve read the rows on both sides.
    {"tags": {"team": ["a"]}},
    {"tool": "web_search"},
    # Exclusions over the keys the rollups keep are served by them.
    {"refine": UsageRefinements(exclude_model=["gpt-4o"], exclude_status=["absorbed", "error"])},
    {"refine": UsageRefinements(exclude_user_id=["u1"], exclude_api_key_id=["k2"], exclude_source=["claude-code"])},
    {"model": ["gpt-4o", "claude-sonnet"], "refine": UsageRefinements(exclude_model=["claude-sonnet"])},
    # The routing policy and the thresholds only the rows carry.
    {"refine": UsageRefinements(policy_name=["fast"])},
    {"refine": UsageRefinements(exclude_policy_name=["fast"], routed=True)},
    {"refine": UsageRefinements(routed=False)},
    {"refine": UsageRefinements(tokens_gt=3000)},
    {"refine": UsageRefinements(cost_gt=0.5, latency_ms_gt=1000)},
]

_VALUE_GROUPS = ("model", "user", "api_key", "provider", "status", "source", "source_label", "policy")

_DIMENSIONS = ("model", "user", "api_key", "source", "source_label", "endpoint", "provider")


def _scopes(workspace_id: uuid.UUID) -> list[UsageScope]:
    return [
        UsageScope(workspaces=None),
        UsageScope(workspaces=[workspace_id]),
        UsageScope(workspaces=[workspace_id], api_key_id="k1"),
        UsageScope(workspaces=[]),
    ]


async def _reads(reader: _Reader, filters: UsageFilters, scope: UsageScope) -> dict[str, Any]:
    """Every aggregate read the rollups serve, in a comparable shape."""
    async with reader.uow:
        return await _read_all(reader.repo, filters, scope)


async def _read_all(repo: UsageLogRepository, filters: UsageFilters, scope: UsageScope) -> dict[str, Any]:
    out: dict[str, Any] = {
        "totals": (await repo.totals(filters, scope)).model_dump(),
        "count": await repo.count_matching(filters, scope),
        "imported": await repo.count_matching(filters, scope, imported_only=True),
        "cost_and_requests": await repo.cost_and_requests(filters, scope),
        "tools": [row.model_dump() for row in await repo.tool_usage(filters, scope)],
        "errors": await repo.errors_by_status_code(filters, scope, limit=2),
        "tag_groups": [row.model_dump() for row in await repo.groups(filters, scope, tag_key="team", limit=10)],
    }
    for dimension in _DIMENSIONS:
        out[f"groups:{dimension}"] = [
            row.model_dump() for row in await repo.groups(filters, scope, dimension=dimension, limit=None)
        ]
    for dimension in ("model", "source_label"):
        out[f"top:{dimension}"] = [
            row.model_dump() for row in await repo.groups(filters, scope, dimension=dimension, limit=2)
        ]
    for group_by in _VALUE_GROUPS:
        groups, total = await repo.value_groups(
            filters, scope, group_by=group_by, search=None, named=(), skip=0, limit=200
        )
        out[f"values:{group_by}"] = ([group.model_dump() for group in groups], total)
    searched, total = await repo.value_groups(
        filters, scope, group_by="user", search="U", named=("k-none",), skip=0, limit=1
    )
    out["values:searched"] = ([group.model_dump() for group in searched], total)
    for bucket in ("hour", "day"):
        points = await repo.series(filters, scope, bucket=bucket)
        out[f"series:{bucket}"] = sorted((point.model_dump() for point in points), key=lambda p: p["bucket_start"])
    grids: tuple[tuple[Bucket, str, set[str], bool], ...] = (
        ("day", "model", {"gpt-4o"}, False),
        ("hour", "user", {"u1"}, True),
    )
    for bucket, dimension, named, keeps_null in grids:
        cells = await repo.grouped_series(
            filters, scope, bucket=bucket, dimension=dimension, named=named, keeps_null=keeps_null
        )
        out[f"grouped:{bucket}:{dimension}"] = sorted(
            (cell.model_dump() for cell in cells),
            key=lambda c: (c["bucket_start"], c["key"] or "", c["is_other"]),
        )
    return out


async def _assert_parity(
    rollups: _Reader, rows: _Reader, rng: random.Random, workspace_id: uuid.UUID, *, stride: int
) -> None:
    scopes = _scopes(workspace_id)
    for index, (start, end) in enumerate(_windows(rng)):
        for offset, spec in enumerate(_FILTERS):
            # Each filter meets every ``stride``-th window, and the scopes take turns.
            if (index + offset) % stride:
                continue
            scope = scopes[(index + offset) // stride % len(scopes)]
            filters = UsageFilters(start_date=start, end_date=end, **spec)
            assert await _reads(rollups, filters, scope) == await _reads(rows, filters, scope), (
                start,
                end,
                spec,
                scope,
            )


async def _offering_parity(rollups: _Reader, rows: _Reader, workspace_id: uuid.UUID) -> None:
    offerings = [("openai/gpt-4o", "openai", "gpt-4o"), ("anthropic/claude-sonnet", "anthropic", "claude-sonnet")]

    async def traffic(reader: _Reader) -> list[Any]:
        async with reader.uow:
            found = await reader.repo.offering_traffic(
                UsageScope(workspaces=[workspace_id]), since=_BASE + timedelta(hours=3, minutes=20), offerings=offerings
            )
        return sorted(found, key=lambda t: (t.provider or "", t.model))

    assert await traffic(rollups) == await traffic(rows)


async def _marked(async_db: AsyncSession) -> int:
    return int((await async_db.execute(select(func.count()).select_from(UsageRollupDirtyHour))).scalar_one())


@pytest.mark.asyncio
async def test_rollups_answer_as_the_rows_do(
    test_db: Session, async_db: AsyncSession, sessions: tuple[_Reader, _Reader]
) -> None:
    """Built, then written to again (insert, reprice, reassign, delete), the rollups keep matching the rows."""
    rng = random.Random(2026)
    workspace_id = seed_workspace_id(test_db)
    _seed_identities(test_db, workspace_id)
    test_db.add_all(_rows(rng, workspace_id, 900))
    test_db.commit()
    rollups, rows = sessions

    assert await _refresh_all(async_db) >= _HOURS - 1
    await async_db.commit()
    assert await _marked(async_db) == 0
    built = (await async_db.execute(select(func.count(), func.sum(UsageRollup.rows)))).one()
    assert built[1] == 900
    assert built[0] < 900, "an hour's rows that share every key should share one rollup row"
    await _assert_parity(rollups, rows, rng, workspace_id, stride=3)
    await _offering_parity(rollups, rows, workspace_id)

    # Writes after the build mark their hours, and a read takes those from the rows.
    test_db.add_all(_rows(rng, workspace_id, 60))
    test_db.execute(
        update(UsageLog)
        .where(UsageLog.timestamp < _BASE + timedelta(hours=6), UsageLog.status == "success")
        .values(cost=Decimal("0.5"))
    )
    test_db.execute(update(UsageLog).where(UsageLog.user_id == "u2").values(user_id="u1", source_label=None))
    test_db.execute(delete(UsageLog).where(UsageLog.timestamp >= _BASE + timedelta(hours=33)))
    test_db.commit()
    assert 0 < await _marked(async_db)
    await _assert_parity(rollups, rows, rng, workspace_id, stride=6)
    await _offering_parity(rollups, rows, workspace_id)

    await _refresh_all(async_db)
    await async_db.commit()
    assert await _marked(async_db) == 0
    await _assert_parity(rollups, rows, rng, workspace_id, stride=6)


@pytest.mark.asyncio
async def test_a_user_deleted_after_the_build_reads_as_the_rows_do(
    test_db: Session, async_db: AsyncSession, sessions: tuple[_Reader, _Reader]
) -> None:
    """The foreign key's ``SET NULL`` is an update the triggers see, so the user's hours are marked."""
    rng = random.Random(11)
    workspace_id = seed_workspace_id(test_db)
    _seed_identities(test_db, workspace_id)
    test_db.add_all(_rows(rng, workspace_id, 300))
    test_db.commit()
    await _refresh_all(async_db)
    await async_db.commit()

    test_db.execute(delete(APIKey).where(APIKey.id == "k2"))
    test_db.execute(delete(User).where(User.user_id == "u2"))
    test_db.commit()
    assert await _marked(async_db) > 0
    rollups, rows = sessions
    filters = UsageFilters(start_date=_BASE + timedelta(minutes=30), end_date=_BASE + timedelta(hours=35))
    scope = UsageScope(workspaces=None)
    assert await _reads(rollups, filters, scope) == await _reads(rows, filters, scope)


@pytest.mark.asyncio
async def test_the_triggers_mark_the_hours_a_write_touches(test_db: Session, async_db: AsyncSession) -> None:
    """An insert marks its rows' hours, an update both the old and the new ones, a delete the ones it removed."""
    workspace_id = seed_workspace_id(test_db)
    rng = random.Random(3)
    row = _row(rng, workspace_id, _BASE + timedelta(hours=1, minutes=5))
    row.user_id = None
    row.api_key_id = None
    test_db.add(row)
    test_db.commit()

    async def marked() -> set[datetime]:
        result = await async_db.execute(select(UsageRollupDirtyHour.hour).distinct())
        await async_db.commit()
        return set(result.scalars())

    assert await marked() == {_BASE + timedelta(hours=1)}
    await async_db.execute(delete(UsageRollupDirtyHour))
    await async_db.commit()

    test_db.execute(update(UsageLog).where(UsageLog.id == row.id).values(timestamp=_BASE + timedelta(hours=4)))
    test_db.commit()
    assert await marked() == {_BASE + timedelta(hours=1), _BASE + timedelta(hours=4)}
    await async_db.execute(delete(UsageRollupDirtyHour))
    await async_db.commit()

    test_db.execute(delete(UsageLog).where(UsageLog.id == row.id))
    test_db.commit()
    assert await marked() == {_BASE + timedelta(hours=4)}


@pytest.mark.asyncio
async def test_a_refresh_leaves_the_current_hour_and_builds_the_newest_first(
    test_db: Session, async_db: AsyncSession
) -> None:
    """The hour ``now`` falls in stays marked until it is over, and older hours wait for later passes."""
    workspace_id = seed_workspace_id(test_db)
    rng = random.Random(5)
    for hour in range(6):
        row = _row(rng, workspace_id, _BASE + timedelta(hours=hour, minutes=10))
        row.user_id = None
        row.api_key_id = None
        test_db.add(row)
    test_db.commit()
    service = _service(async_db)

    assert await service.refresh(2, now=_BASE + timedelta(hours=5, minutes=30)) == 2
    hours = set((await async_db.execute(select(UsageRollup.hour).distinct())).scalars())
    assert hours == {_BASE + timedelta(hours=3), _BASE + timedelta(hours=4)}
    assert await service.marked_hours() == 4

    assert await service.refresh(24, now=_BASE + timedelta(hours=5, minutes=30)) == 3
    assert await service.marked_hours() == 1


@pytest.mark.asyncio
async def test_a_refresh_another_holds_the_lock_for_builds_nothing(test_db: Session, async_db: AsyncSession) -> None:
    """Two refreshes building one hour would each delete the sums the other has not committed."""
    workspace_id = seed_workspace_id(test_db)
    row = _row(random.Random(9), workspace_id, _BASE)
    row.user_id = None
    row.api_key_id = None
    test_db.add(row)
    test_db.commit()
    test_db.execute(text("SELECT pg_advisory_lock(:key)"), {"key": 0x7573_6167_6572_6F6C})
    try:
        service = _service(async_db)
        assert await service.refresh(now=_FAR_FUTURE) == 0
        assert await service.marked_hours() == 1
    finally:
        test_db.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": 0x7573_6167_6572_6F6C})
        test_db.commit()


@pytest.mark.asyncio
async def test_a_window_with_too_many_marked_hours_reads_the_rows(
    test_db: Session, async_db: AsyncSession, sessions: tuple[_Reader, _Reader]
) -> None:
    """Before the history is built, a window's whole span comes from the rows, and still matches."""
    workspace_id = seed_workspace_id(test_db)
    _seed_identities(test_db, workspace_id)
    rng = random.Random(13)
    test_db.add_all(
        _row(rng, workspace_id, _BASE + timedelta(hours=hour, minutes=rng.randint(0, 59)))
        for hour in range(MAX_MARKED_HOURS + 10)
    )
    test_db.commit()
    assert await _marked(async_db) >= MAX_MARKED_HOURS + 10
    rollups, rows = sessions
    filters = UsageFilters(start_date=_BASE, end_date=_BASE + timedelta(hours=MAX_MARKED_HOURS + 10))
    scope = UsageScope(workspaces=None)
    assert await _reads(rollups, filters, scope) == await _reads(rows, filters, scope)


@pytest.mark.asyncio
async def test_whole_hours_come_from_the_rollups_and_edge_hours_from_the_rows(
    test_db: Session, async_db: AsyncSession, sessions: tuple[_Reader, _Reader]
) -> None:
    """With the rows removed behind the triggers' back, only the whole hours the rollups hold still count."""
    workspace_id = seed_workspace_id(test_db)
    rng = random.Random(17)
    for hour in range(4):
        row = _row(rng, workspace_id, _BASE + timedelta(hours=hour, minutes=30))
        row.user_id = None
        row.api_key_id = None
        row.status = "success"
        test_db.add(row)
    test_db.commit()
    await _refresh_all(async_db)
    await async_db.commit()
    test_db.execute(text("ALTER TABLE usage_logs DISABLE TRIGGER USER"))
    try:
        test_db.execute(delete(UsageLog))
        test_db.commit()
    finally:
        test_db.execute(text("ALTER TABLE usage_logs ENABLE TRIGGER USER"))
        test_db.commit()
    rollups, rows = sessions
    # Hours 1 and 2 are whole inside the window; hours 0 and 3 are its edges.
    filters = UsageFilters(start_date=_BASE + timedelta(minutes=10), end_date=_BASE + timedelta(hours=3, minutes=10))
    scope = UsageScope(workspaces=None)
    async with rollups.uow:
        assert await rollups.repo.count_matching(filters, scope) == 2
    async with rows.uow:
        assert await rows.repo.count_matching(filters, scope) == 0


@pytest.mark.asyncio
async def test_a_refinement_the_rollups_do_not_key_reads_the_rows(
    test_db: Session, async_db: AsyncSession, sessions: tuple[_Reader, _Reader]
) -> None:
    """An exclusion is answered from the rollups; a policy or a threshold, which only the rows carry, from the rows."""
    workspace_id = seed_workspace_id(test_db)
    _seed_identities(test_db, workspace_id)
    rng = random.Random(19)
    for hour in range(4):
        row = _row(rng, workspace_id, _BASE + timedelta(hours=hour, minutes=30))
        row.model = "gpt-4o"
        test_db.add(row)
    test_db.commit()
    await _refresh_all(async_db)
    await async_db.commit()
    test_db.execute(text("ALTER TABLE usage_logs DISABLE TRIGGER USER"))
    try:
        test_db.execute(delete(UsageLog))
        test_db.commit()
    finally:
        test_db.execute(text("ALTER TABLE usage_logs ENABLE TRIGGER USER"))
        test_db.commit()
    rollups, _ = sessions
    window = {"start_date": _BASE, "end_date": _BASE + timedelta(hours=4)}
    scope = UsageScope(workspaces=None)
    async with rollups.uow:
        excluded = UsageFilters(**window, refine=UsageRefinements(exclude_model=["claude-sonnet"]))
        assert await rollups.repo.count_matching(excluded, scope) == 4
        for refine in (
            UsageRefinements(routed=False),
            UsageRefinements(tokens_gt=0),
            UsageRefinements(cost_gt=0),
            UsageRefinements(latency_ms_gt=0),
            UsageRefinements(policy_name=["fast"]),
        ):
            assert await rollups.repo.count_matching(UsageFilters(**window, refine=refine), scope) == 0, refine
