"""The hourly usage rollups: what marks an hour, what a refresh builds, and that a read answers the same from them.

Every read the Usage page makes is asked twice over the same rows: once while
every hour is marked, so it reads the rows themselves, and once after a refresh
built the rollups, so it reads their sums for every whole hour. The answers must
match to the cent and the row.
"""

from __future__ import annotations

import asyncio
import math
import random
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta, timezone
from typing import Any, get_args

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session

from conftest import seed_workspace_id
from gateway.core.config import API_ROOT, GatewayConfig
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import TOOL_METER_NAMESPACE
from gateway.models.api_keys import APIKey
from gateway.models.tenancy import Workspace
from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT, UsageLog, UsageRollup, UsageRollupDirtyHour
from gateway.models.users import User
from gateway.repositories.usage import UsageReadRepository, UsageRollupRepository, UsageSummaryRepository
from gateway.repositories.usage.usage_summary_repository import _breakdown, _in_keys
from gateway.schemas.usage import BreakdownDimension

from .conftest import _to_async_url

T0 = datetime(2026, 9, 1, tzinfo=UTC)
USAGE = f"{API_ROOT}/usage"


def _refresh(config: GatewayConfig) -> int:
    """Run refreshes until no hour is marked, and return how many hours they built."""

    async def main() -> int:
        engine = create_async_engine(_to_async_url(config.database_url))
        built = 0
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                uow = UnitOfWork(session)
                while True:
                    async with uow:
                        done = await UsageRollupRepository(uow).refresh(24, now=datetime.now(UTC))
                    built += done
                    if not done:
                        return built
        finally:
            await engine.dispose()

    return asyncio.run(main())


def _meters(rng: random.Random, prompt: int | None, completion: int | None) -> dict[str, Any] | None:
    if rng.random() < 0.2:
        return None
    meters: dict[str, Any] = {
        "total_input_tokens": (prompt or 0) + rng.randint(0, 500),
        "completion_tokens": completion or 0,
        "cache_read_tokens": rng.randint(0, 300),
        "cache_write_tokens": rng.randint(0, 50),
    }
    if rng.random() < 0.15:
        del meters["total_input_tokens"]
    tools: dict[str, Any] = {}
    for tool in ("web_search", "code_execution", "web_fetch"):
        if rng.random() < 0.3:
            tools[tool] = {"billed": rng.randint(0, 4), "errors": rng.randint(0, 2), "unit_rate": 0.01}
    if tools:
        meters[TOOL_METER_NAMESPACE] = tools
    return meters


def _seed(db: Session, *, hours: int = 6, per_hour: int = 40, seed: int = 7) -> None:
    """Varied rows over ``hours`` hours from ``T0``: every key a read groups by, nulls, failures, imports and tools."""
    rng = random.Random(seed)
    workspace = seed_workspace_id(db)
    other = uuid.uuid4()
    home = db.get(Workspace, workspace)
    assert home is not None
    db.add(Workspace(id=other, name="other", organization_id=home.organization_id))
    for user in ("u1", "u2"):
        db.add(User(user_id=user, alias=user.upper(), spend=0.0, blocked=False))
    db.flush()
    db.add(APIKey(id="k1", key_hash="h1", key_name="one", user_id="u1", workspace_id=workspace))
    db.add(APIKey(id="k2", key_hash="h2", key_name="Two", user_id="u2", workspace_id=workspace, internal_secret="s"))
    db.flush()
    for hour in range(hours):
        for _ in range(per_hour):
            prompt = rng.choice([None, rng.randint(1, 2000)])
            completion = rng.choice([None, rng.randint(1, 800)])
            status = rng.choices(["success", "error", "absorbed"], weights=[8, 1, 1])[0]
            db.add(
                UsageLog(
                    id=str(uuid.uuid4()),
                    workspace_id=other if rng.random() < 0.1 else workspace,
                    user_id=rng.choice(["u1", "u2", None]),
                    api_key_id=rng.choice(["k1", "k2", None]),
                    timestamp=T0 + timedelta(hours=hour, seconds=rng.randint(0, 3599)),
                    model=rng.choice(["alpha", "beta", "gamma"]),
                    requested_model=rng.choice([None, "fast"]),
                    provider=rng.choice(["openai", "anthropic", None]),
                    endpoint=rng.choice(["/v1/chat/completions", "/v1/messages", PLAYGROUND_USAGE_ENDPOINT]),
                    source=rng.choice(["gateway", "gateway", "claude_code"]),
                    source_label=rng.choice([None, "session-a", "session-b", "session-c"]),
                    policy_name=rng.choice([None, "cheap-first"]),
                    prompt_tokens=prompt,
                    completion_tokens=completion,
                    total_tokens=None if prompt is None else prompt + (completion or 0),
                    cache_read_tokens=rng.choice([None, rng.randint(0, 300)]),
                    cache_write_tokens=rng.choice([None, rng.randint(0, 50)]),
                    reasoning_tokens=rng.choice([None, rng.randint(0, 100)]),
                    billing_meters=_meters(rng, prompt, completion),
                    cost=rng.choice([None, round(rng.uniform(0, 0.2), 6)]),
                    status=status,
                    status_code=rng.choice([429, 500, 503]) if status == "error" else 200,
                    latency_ms=rng.choice([None, rng.randint(50, 9000)]),
                    tags={"team": rng.choice(["red", "blue"])},
                )
            )
    db.commit()


def _window(start: datetime, end: datetime) -> dict[str, str]:
    return {"start_date": start.isoformat(), "end_date": end.isoformat()}


EDGES = _window(T0 - timedelta(minutes=37), T0 + timedelta(hours=5, minutes=13))
# Bounds in a zone half an hour off UTC, whose hours are not the rollups' hours.
INDIA = timezone(timedelta(hours=5, minutes=30))
OFFSET = _window(
    (T0 + timedelta(minutes=10)).astimezone(INDIA), (T0 + timedelta(hours=4, minutes=50)).astimezone(INDIA)
)
WHOLE = _window(T0, T0 + timedelta(hours=6))

# Each read the Usage page makes, and the variations a filter or a sort gives it.
READS: list[tuple[str, dict[str, Any]]] = [
    ("summary", {**EDGES, "bucket": "hour"}),
    ("summary", {**WHOLE, "bucket": "day"}),
    ("summary", {**EDGES, "bucket": "5min", "dimensions": ["model"]}),
    ("summary", {**_window(T0 + timedelta(minutes=10), T0 + timedelta(minutes=50)), "bucket": "hour"}),
    *(
        (
            "summary",
            {**EDGES, "bucket": "hour", "dimensions": ["user", "source_label"], "rank_by": rank, "rank_order": order},
        )
        for rank in ("cost", "billed", "tokens", "requests", "imported", "errors", "name", "p95")
        for order in ("desc", "asc")
    ),
    ("summary", {**EDGES, "dimensions": ["source_label"], "session_details": "true"}),
    ("summary", {**EDGES, "dimensions": ["model"], "p95_by": "model", "include_p95": "true"}),
    ("summary", {**EDGES, "dimensions": ["none"], "group_by_tag": "team"}),
    ("summary", {**EDGES, "status": "absorbed", "dimensions": ["model", "tool"]}),
    ("summary", {**EDGES, "model": ["alpha", "beta"], "user_id": "u1"}),
    ("summary", {**EDGES, "q": "sess"}),
    ("summary", {**EDGES, "q": str(uuid.UUID(int=1))}),
    ("summary", {**EDGES, "priced": "false"}),
    ("summary", {**EDGES, "tool": "web_search"}),
    ("summary", {**EDGES, "exclude_model": "gamma", "routed": "true", "channel": "api"}),
    ("summary", {**EDGES, "is_null": "user_id", "source": "gateway"}),
    ("summary", {**EDGES, "cost_gt": "0.1"}),
    ("summary", {**EDGES, "requested_model": "fast", "endpoint": "/v1/messages"}),
    ("summary", {**OFFSET, "bucket": "hour"}),
    ("latency", {**EDGES, "group_by": "model"}),
    ("latency", {**EDGES, "group_by": "channel", "rank_by": "errors"}),
    ("latency", {**EDGES}),
    ("tools", {**EDGES}),
    ("tools", {**WHOLE, "provider": "openai"}),
    *(("series", {**EDGES, "bucket": "hour", "group_by": by}) for by in ("model", "user_id", "api_key_id", "channel")),
    ("series", {**WHOLE, "bucket": "day", "group_by": "source_label", "rank_by": "tokens"}),
]


def _read_all(client: TestClient, headers: dict[str, str]) -> list[Any]:
    answers = []
    for path, params in READS:
        response = client.get(f"{USAGE}/{path}", params=params, headers=headers)
        assert response.status_code == 200, (path, params, response.text)
        answer = response.json()
        # A grouped series orders its cells by bucket alone, so a bucket's are in no set order.
        if "points" in answer:
            answer["points"].sort(key=lambda p: (p["bucket_start"], p["is_other"], p["key"] or ""))
        answers.append(answer)
    return answers


def _assert_same(left: Any, right: Any, where: str = "") -> None:
    if isinstance(left, float) or isinstance(right, float):
        assert left is not None and right is not None, where
        assert math.isclose(left, right, rel_tol=1e-9, abs_tol=1e-9), (where, left, right)
    elif isinstance(left, dict):
        assert left.keys() == right.keys(), where
        for key in left:
            _assert_same(left[key], right[key], f"{where}.{key}")
    elif isinstance(left, list):
        assert len(left) == len(right), (where, len(left), len(right))
        for index, (a, b) in enumerate(zip(left, right, strict=True)):
            _assert_same(a, b, f"{where}[{index}]")
    else:
        assert left == right, (where, left, right)


def _count(db: Session, model: type[Any]) -> int:
    db.expire_all()
    return int(db.execute(select(func.count()).select_from(model)).scalar_one())


def test_every_read_answers_the_same_from_the_rollups_as_from_the_rows(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, test_config: GatewayConfig
) -> None:
    _seed(db_session)
    assert _count(db_session, UsageRollupDirtyHour) > 0
    from_rows = _read_all(client, master_key_header)

    assert _refresh(test_config) == 6
    assert _count(db_session, UsageRollupDirtyHour) == 0
    assert _count(db_session, UsageRollup) > 0
    from_rollups = _read_all(client, master_key_header)

    for (path, params), left, right in zip(READS, from_rows, from_rollups, strict=True):
        _assert_same(left, right, f"{path} {params}")


def _overviews(client: TestClient, headers: dict[str, str], workspace: uuid.UUID) -> list[Any]:
    answers = []
    for scope in ("organization", "workspace", "you"):
        params = {"month": "2026-09", "scope": scope, "workspace_id": str(workspace)}
        response = client.get(f"{API_ROOT}/overview", params=params, headers=headers)
        assert response.status_code == 200, (scope, response.text)
        answers.append(response.json())
    return answers


def test_the_overview_month_answers_the_same_from_the_rollups_as_from_the_rows(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, test_config: GatewayConfig
) -> None:
    _seed(db_session, seed=5)
    workspace = seed_workspace_id(db_session)
    from_rows = _overviews(client, master_key_header, workspace)

    _refresh(test_config)
    assert _count(db_session, UsageRollupDirtyHour) == 0
    from_rollups = _overviews(client, master_key_header, workspace)

    _assert_same(from_rows, from_rollups)
    assert any(answer["limits"]["rows"] for answer in from_rollups)


def test_a_write_after_a_refresh_is_read_at_once_and_folded_in_by_the_next(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, test_config: GatewayConfig
) -> None:
    _seed(db_session, seed=11)
    _refresh(test_config)
    # A late import into an hour already built, a reprice, and a delete.
    _seed_more(db_session)
    rows = db_session.execute(select(UsageLog.id).where(UsageLog.timestamp < T0 + timedelta(hours=1))).scalars().all()
    db_session.execute(update(UsageLog).where(UsageLog.id == rows[0]).values(cost=12.5))
    db_session.execute(delete(UsageLog).where(UsageLog.id == rows[1]))
    db_session.commit()
    assert _count(db_session, UsageRollupDirtyHour) > 0
    mixed = _read_all(client, master_key_header)

    _refresh(test_config)
    rebuilt = _read_all(client, master_key_header)

    for (path, params), left, right in zip(READS, mixed, rebuilt, strict=True):
        _assert_same(left, right, f"{path} {params}")
    totals = client.get(f"{USAGE}/summary", params={**WHOLE, "dimensions": ["none"]}, headers=master_key_header)
    assert totals.json()["totals"]["cost"] >= 12.5


def _seed_more(db: Session) -> None:
    db.add(
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=seed_workspace_id(db),
            timestamp=T0 + timedelta(hours=2, minutes=30),
            model="delta",
            endpoint="/v1/messages",
            source="claude_code",
            cost=1.25,
            status="success",
            prompt_tokens=100,
            completion_tokens=10,
        )
    )
    db.commit()


def _marked(db: Session) -> set[datetime]:
    db.expire_all()
    return set(db.execute(select(UsageRollupDirtyHour.hour)).scalars())


@pytest.mark.parametrize(
    ("change", "hours"),
    [
        (lambda db, row: db.execute(update(UsageLog).where(UsageLog.id == row).values(cost=3)), {T0}),
        (lambda db, row: db.execute(delete(UsageLog).where(UsageLog.id == row)), {T0}),
        (
            lambda db, row: db.execute(
                update(UsageLog).where(UsageLog.id == row).values(timestamp=T0 + timedelta(hours=4, minutes=5))
            ),
            {T0, T0 + timedelta(hours=4)},
        ),
    ],
    ids=["update", "delete", "move"],
)
def test_a_write_marks_every_hour_it_touched(
    db_session: Session, test_config: GatewayConfig, change: Callable[[Session, str], Any], hours: set[datetime]
) -> None:
    row = str(uuid.uuid4())
    db_session.add(
        UsageLog(
            id=row,
            workspace_id=seed_workspace_id(db_session),
            timestamp=T0 + timedelta(minutes=20),
            model="m",
            endpoint="/v1/messages",
            status="success",
        )
    )
    db_session.commit()
    assert _marked(db_session) == {T0}
    _refresh(test_config)
    assert _marked(db_session) == set()

    change(db_session, row)
    db_session.commit()

    assert _marked(db_session) == hours


def test_a_whole_hour_is_read_from_its_rollups(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, test_config: GatewayConfig
) -> None:
    _seed(db_session, hours=3, per_hour=10)
    _refresh(test_config)
    params = {**_window(T0, T0 + timedelta(hours=3)), "dimensions": ["model"]}
    before = client.get(f"{USAGE}/summary", params=params, headers=master_key_header).json()
    overviews = _overviews(client, master_key_header, seed_workspace_id(db_session))
    # Gone from the rows without a mark, which only the rollups still remember.
    db_session.execute(text("ALTER TABLE usage_logs DISABLE TRIGGER USER"))
    db_session.execute(delete(UsageLog).where(UsageLog.timestamp < T0 + timedelta(hours=1)))
    db_session.execute(text("ALTER TABLE usage_logs ENABLE TRIGGER USER"))
    db_session.commit()

    after = client.get(f"{USAGE}/summary", params=params, headers=master_key_header).json()

    _assert_same(before, after)
    _assert_same(overviews, _overviews(client, master_key_header, seed_workspace_id(db_session)))
    assert before["totals"]["request_count"] > 0


def test_an_hour_whose_rows_are_all_gone_loses_its_rollups(db_session: Session, test_config: GatewayConfig) -> None:
    _seed(db_session, hours=2, per_hour=5)
    _refresh(test_config)
    db_session.execute(delete(UsageLog).where(UsageLog.timestamp < T0 + timedelta(hours=1)))
    db_session.commit()

    _refresh(test_config)

    db_session.expire_all()
    hours = set(db_session.execute(select(UsageRollup.hour).distinct()).scalars())
    assert hours == {T0 + timedelta(hours=1)}


def _p95s(config: GatewayConfig, start: datetime, end: datetime) -> tuple[dict[str, Any], dict[str, Any]]:
    """Every p95 the reads offer over ``[start, end)``, from the relation and from ``percentile_disc`` over rows."""

    async def main() -> tuple[dict[str, Any], dict[str, Any]]:
        engine = create_async_engine(_to_async_url(config.database_url))
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as session:
                uow = UnitOfWork(session)
                async with uow:
                    window = [UsageLog.timestamp >= start, UsageLog.timestamp < end]
                    summaries = UsageSummaryRepository(uow)
                    relation: dict[str, Any] = {}
                    rows: dict[str, Any] = {}
                    for name, extra in (("all", []), ("gateway", [UsageLog.source == "gateway"])):
                        conditions = [*window, *extra]
                        usage = await UsageRollupRepository(uow).rows(conditions, start, end, bucket="hour")
                        assert "usage_rollups" in str(usage.compile())
                        relation[name] = await summaries.p95_latency_ms(usage, conditions)
                        rows[name] = await UsageReadRepository(uow).p95_latency_ms(conditions)
                        for dimension in get_args(BreakdownDimension):
                            groups = await summaries.breakdown(dimension, usage, conditions, limit=None)
                            keys = [group.key for group in groups]
                            relation[f"{name}/{dimension}"] = await summaries.group_p95_latency_ms(
                                dimension, keys, usage, conditions
                            )
                            rows[f"{name}/{dimension}"] = await summaries._group_p95(
                                _breakdown(dimension, UsageLog),
                                [*conditions, _in_keys(_breakdown(dimension, UsageLog), keys)],
                            )
                    return relation, rows
        finally:
            await engine.dispose()

    return asyncio.run(main())


def test_every_p95_from_the_rollups_is_the_one_percentile_disc_gives_over_the_rows(
    db_session: Session, test_config: GatewayConfig
) -> None:
    _seed(db_session, seed=13)
    # Ties, so a percentile that lands inside a run of equal latencies is covered.
    for _ in range(30):
        db_session.add(
            UsageLog(
                id=str(uuid.uuid4()),
                workspace_id=seed_workspace_id(db_session),
                timestamp=T0 + timedelta(hours=2, minutes=5),
                model="alpha",
                endpoint="/v1/messages",
                status="success",
                latency_ms=4242,
            )
        )
    db_session.commit()
    _refresh(test_config)

    relation, rows = _p95s(test_config, T0 - timedelta(minutes=37), T0 + timedelta(hours=5, minutes=13))

    assert relation == rows
    assert relation["all"] is not None


def test_a_rollup_without_its_latencies_is_refused(db_session: Session) -> None:
    """What a gateway on the previous version writes in a rolling deploy: its refresh must fail, not store it."""
    columns = (
        "hour, workspace_id, model, endpoint, source, status, needs_pricing, rows, first_at, last_at, "
        "billed_input_tokens, billed_output_tokens, billed_cache_read_tokens, billed_cache_write_tokens, "
        "latency_count, web_search_rows, web_fetch_rows, code_execution_rows"
    )
    values = (
        ":hour, :workspace, 'm', '/v1/messages', 'gateway', 'success', false, 1, :hour, :hour, 0, 0, 0, 0, 0, 0, 0, 0"
    )

    with pytest.raises(IntegrityError):
        db_session.execute(
            text(f"INSERT INTO usage_rollups ({columns}) VALUES ({values})"),
            {"hour": T0, "workspace": seed_workspace_id(db_session)},
        )
    db_session.rollback()


def test_an_hour_with_no_latency_builds_empty_lists(db_session: Session, test_config: GatewayConfig) -> None:
    db_session.add(
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=seed_workspace_id(db_session),
            timestamp=T0 + timedelta(minutes=5),
            model="m",
            endpoint="/v1/messages",
            status="success",
        )
    )
    db_session.commit()

    _refresh(test_config)

    db_session.expire_all()
    built = db_session.execute(select(UsageRollup.latency_values, UsageRollup.latency_counts)).all()
    assert [tuple(row) for row in built] == [([], [])]
