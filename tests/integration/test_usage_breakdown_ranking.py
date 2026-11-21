"""The summary's breakdowns rank by any column, carry charged spend, failures and p95, and group by the newer cuts.

Runs against the PostgreSQL the suite is configured for, where each group's p95 is
``percentile_cont``; the SQLite arm of the same read is pinned in
``tests/unit/test_usage_p95_by_group.py``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from conftest import seed_workspace_id
from gateway.core.config import API_ROOT
from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT, UsageLog
from gateway.models.users import User

SUMMARY_PATH = f"{API_ROOT}/usage/summary"
SERIES_PATH = f"{API_ROOT}/usage/series"


def _row(
    db: Session,
    *,
    model: str,
    cost: str = "0.10",
    status: str = "success",
    latency_ms: int | None = 100,
    counts_toward_budget: bool = True,
    source: str = "gateway",
    endpoint: str = "/v1/chat/completions",
    policy_name: str | None = None,
    tokens: int = 10,
    source_label: str | None = None,
    tags: dict[str, str] | None = None,
) -> None:
    if db.query(User).filter(User.user_id == "rank").first() is None:
        db.add(User(user_id="rank", alias="rank", spend=0.0, blocked=False))
        db.flush()
    db.add(
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=seed_workspace_id(db),
            user_id="rank",
            timestamp=datetime.now(UTC) - timedelta(hours=1),
            model=model,
            provider="openai",
            endpoint=endpoint,
            source=source,
            source_label=source_label,
            prompt_tokens=tokens,
            completion_tokens=0,
            total_tokens=tokens,
            cost=Decimal(cost),
            status=status,
            error_message="boom" if status == "error" else None,
            latency_ms=latency_ms,
            counts_toward_budget=counts_toward_budget,
            policy_name=policy_name,
            tags=tags,
        )
    )


def _summary(client: TestClient, headers: dict[str, str], **params: Any) -> dict[str, Any]:
    response = client.get(SUMMARY_PATH, headers=headers, params={"user_id": "rank", **params})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


@pytest.fixture
def seeded(db_session: Session) -> None:
    """Three models: ``a`` costs most, ``b`` fails most and is slowest, ``c`` is mostly not charged."""
    for latency in (100, 200, 300, 400):
        _row(db_session, model="a", cost="1.00", latency_ms=latency, tokens=5)
    for latency in (1000, 2000):
        _row(db_session, model="b", cost="0.10", status="error", latency_ms=latency, tokens=50)
    _row(db_session, model="b", cost="0.10", latency_ms=3000, tokens=50)
    _row(db_session, model="c", cost="0.30", counts_toward_budget=False, latency_ms=50, tokens=1)
    _row(db_session, model="c", cost="0.20", latency_ms=None, tokens=1, status="absorbed")
    db_session.commit()


def _keys(rows: list[dict[str, Any]]) -> list[str | None]:
    return [row["key"] for row in rows if not row["is_other"]]


@pytest.mark.usefixtures("seeded")
def test_each_group_carries_its_charged_spend_and_failures_and_they_reconcile(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _summary(client, master_key_header, dimensions="model")
    rows = {row["key"]: row for row in body["by_model"]}
    assert rows["a"]["charged_cost"] == pytest.approx(4.0)
    assert rows["c"]["charged_cost"] == pytest.approx(0.2)
    assert rows["c"]["cost"] == pytest.approx(0.5)
    assert rows["b"]["error_count"] == 2
    assert body["totals"]["charged_cost"] == pytest.approx(sum(row["charged_cost"] for row in body["by_model"]))
    assert body["totals"]["error_count"] == sum(row["error_count"] for row in body["by_model"])
    # p95 is read only when asked for.
    assert all(row["p95_latency_ms"] is None for row in body["by_model"])


@pytest.mark.usefixtures("seeded")
@pytest.mark.parametrize(
    ("rank_by", "rank_order", "expected"),
    [
        ("cost", "desc", ["a", "c", "b"]),
        ("cost", "asc", ["b", "c", "a"]),
        ("charged", "desc", ["a", "b", "c"]),
        ("not_charged", "desc", ["c", "a", "b"]),
        ("tokens", "desc", ["b", "a", "c"]),
        ("requests", "asc", ["c", "b", "a"]),
        ("failed", "desc", ["b", "a", "c"]),
        ("p95", "desc", ["b", "a", "c"]),
        ("p95", "asc", ["c", "a", "b"]),
    ],
)
def test_rank_by_orders_every_breakdown(
    client: TestClient, master_key_header: dict[str, str], rank_by: str, rank_order: str, expected: list[str]
) -> None:
    body = _summary(client, master_key_header, dimensions="model", rank_by=rank_by, rank_order=rank_order)
    assert _keys(body["by_model"]) == expected


@pytest.mark.usefixtures("seeded")
def test_p95_by_reads_each_groups_latency_as_percentile_cont_does(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _summary(client, master_key_header, dimensions=["model", "provider"], p95_by="model")
    p95 = {row["key"]: row["p95_latency_ms"] for row in body["by_model"]}
    # Four latencies 100..400: rank 0.95 * 3 = 2.85, so 300 + 0.85 * 100.
    assert p95 == {"a": 385, "b": 2900, "c": 50}
    # Only the breakdown it named.
    assert all(row["p95_latency_ms"] is None for row in body["by_provider"])


def test_ranking_picks_which_groups_make_the_cap(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """105 models: by cost the one failure falls in the fold, ranked by failures it leads."""
    for index in range(104):
        _row(db_session, model=f"m{index:03d}", cost="1.00")
    _row(db_session, model="zz-failing", cost="0.00", status="error")
    db_session.commit()
    by_cost = _summary(client, master_key_header, dimensions="model")["by_model"]
    assert "zz-failing" not in _keys(by_cost)
    assert by_cost[-1]["is_other"] and by_cost[-1]["error_count"] == 1
    by_failed = _summary(client, master_key_header, dimensions="model", rank_by="failed")["by_model"]
    assert _keys(by_failed)[0] == "zz-failing"
    assert sum(row["requests"] for row in by_failed) == 105


def test_the_tag_breakdown_carries_charged_spend_and_failures(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """Its fold subtracts the listed groups from the totals, so each group has to carry both figures."""
    _row(db_session, model="a", cost="1.00", tags={"role": "x"})
    _row(db_session, model="a", cost="0.50", counts_toward_budget=False, tags={"role": "x"})
    _row(db_session, model="a", cost="0.25", status="error", tags={"role": "y"})
    db_session.commit()
    body = _summary(client, master_key_header, dimensions="none", group_by_tag="role")
    rows = {row["key"]: row for row in body["by_tag"]}
    assert rows["x"]["charged_cost"] == pytest.approx(1.0)
    assert rows["y"]["error_count"] == 1
    assert body["totals"]["charged_cost"] == pytest.approx(sum(row["charged_cost"] for row in body["by_tag"]))
    assert body["totals"]["error_count"] == sum(row["error_count"] for row in body["by_tag"])


def test_channel_policy_and_workspace_breakdowns(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, model="a", policy_name="fast", source_label="s1")
    _row(db_session, model="a", policy_name="fast")
    _row(db_session, model="a", source="claude_code", counts_toward_budget=False)
    _row(db_session, model="a", endpoint=PLAYGROUND_USAGE_ENDPOINT, status="error")
    db_session.commit()
    body = _summary(
        client,
        master_key_header,
        dimensions=["channel", "policy", "workspace", "source_label"],
        p95_by="policy",
    )
    channels = {row["key"]: row for row in body["by_channel"]}
    assert {key: row["requests"] for key, row in channels.items()} == {"api": 2, "imported": 1, "playground": 1}
    assert channels["imported"]["charged_cost"] == 0
    assert channels["playground"]["error_count"] == 1
    policies = {row["key"]: row for row in body["by_policy"]}
    # A request that named a model directly groups under a null key.
    assert {key: row["requests"] for key, row in policies.items()} == {"fast": 2, None: 2}
    assert policies["fast"]["p95_latency_ms"] == 100
    workspace = str(seed_workspace_id(db_session))
    assert [(row["key"], row["requests"]) for row in body["by_workspace"]] == [(workspace, 4)]
    assert {row["key"]: row["requests"] for row in body["by_source_label"]} == {"s1": 1, None: 3}


def test_the_series_splits_by_channel_session_and_policy(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, model="a", policy_name="fast", source_label="s1")
    _row(db_session, model="a", source="claude_code")
    db_session.commit()
    for group_by, expected in (
        ("channel", {"api", "imported"}),
        ("policy_name", {"fast", None}),
        ("source_label", {"s1", None}),
    ):
        response = client.get(SERIES_PATH, headers=master_key_header, params={"user_id": "rank", "group_by": group_by})
        assert response.status_code == 200, response.text
        body = response.json()
        assert {group["key"] for group in body["groups"]} == expected
        assert sum(point["requests"] for point in body["points"]) == 2


def test_rank_by_rejects_an_unknown_column(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert client.get(SUMMARY_PATH, headers=master_key_header, params={"rank_by": "nope"}).status_code == 422
    assert client.get(SUMMARY_PATH, headers=master_key_header, params={"p95_by": "tool"}).status_code == 422


@pytest.mark.parametrize("dimensions", [None, ["model", "provider"], ["none"], ["model", "tool"]])
def test_rank_by_p95_takes_exactly_one_breakdown(
    client: TestClient, master_key_header: dict[str, str], dimensions: list[str] | None
) -> None:
    """Each breakdown ranked by p95 reads every group's latency, so more than one, or none, is refused."""
    params: dict[str, Any] = {"rank_by": "p95"}
    if dimensions is not None:
        params["dimensions"] = dimensions
    response = client.get(SUMMARY_PATH, headers=master_key_header, params=params)
    if dimensions == ["model", "tool"]:
        # The tool spend is no ranked breakdown, so one remains.
        assert response.status_code == 200, response.text
        return
    assert response.status_code == 422, response.text
    assert "exactly one breakdown" in response.text
