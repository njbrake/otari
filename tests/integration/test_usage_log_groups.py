"""The request log grouped by one column: what each group adds up to, how groups rank, and paging.

Parity between the rollups and the rows is pinned in ``test_usage_rollups.py``,
and tenant scoping on the organization route in
``test_organization_usage_scope.py``.
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
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User

GROUPED_PATH = f"{API_ROOT}/usage/grouped"


def _log(
    db: Session,
    *,
    minutes_ago: int,
    model: str = "gpt-4o",
    user_id: str | None = "ada",
    api_key_id: str | None = None,
    status: str = "success",
    cost: str = "0.01",
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    latency_ms: int | None = 100,
    source_label: str | None = None,
) -> datetime:
    workspace_id = seed_workspace_id(db)
    if user_id is not None and db.get(User, user_id) is None:
        db.add(User(user_id=user_id, alias=f"{user_id.title()} Person", spend=0.0, blocked=False))
        db.flush()
    if api_key_id is not None and db.get(APIKey, api_key_id) is None:
        db.add(
            APIKey(
                id=api_key_id,
                key_hash=f"hash-{api_key_id}",
                key_name=f"{api_key_id} laptop",
                user_id=user_id,
                workspace_id=workspace_id,
            )
        )
        db.flush()
    timestamp = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=minutes_ago)
    db.add(
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=workspace_id,
            user_id=user_id,
            api_key_id=api_key_id,
            timestamp=timestamp,
            model=model,
            provider="openai",
            endpoint="/v1/chat/completions",
            source="gateway",
            source_label=source_label,
            counts_toward_budget=True,
            status=status,
            error_message="boom" if status == "error" else None,
            cost=Decimal(cost),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            latency_ms=latency_ms,
            request_group_id=str(uuid.uuid4()),
        )
    )
    return timestamp


@pytest.fixture
def seeded(db_session: Session) -> dict[str, datetime]:
    """Two keys and a keyless row: k1 is busiest, k2 most recent and most costly."""
    times = {
        "k2_new": _log(db_session, minutes_ago=1, api_key_id="k2", model="claude", cost="0.50", latency_ms=300),
        "k1_new": _log(db_session, minutes_ago=5, api_key_id="k1", latency_ms=200),
        "k1_error": _log(db_session, minutes_ago=6, api_key_id="k1", status="error", latency_ms=None),
        "k1_absorbed": _log(db_session, minutes_ago=7, api_key_id="k1", model="claude", status="absorbed"),
        "k1_old": _log(db_session, minutes_ago=30, api_key_id="k1", model="gpt-4o-mini", prompt_tokens=100),
        "none": _log(db_session, minutes_ago=40, user_id="bob", source_label="sess-1"),
    }
    db_session.commit()
    return times


def _get(client: TestClient, headers: dict[str, str], **params: Any) -> dict[str, Any]:
    response = client.get(GROUPED_PATH, headers=headers, params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _instant(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def test_a_group_sums_its_requests(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, datetime]
) -> None:
    body = _get(client, master_key_header, group_by="api_key")
    assert body["group_by"] == "api_key"
    assert body["order"] == "recent"
    assert body["total"] == 3
    by_key = {group["key"]: group for group in body["groups"]}
    k1 = by_key["k1"]
    assert k1["label"] == "k1 laptop"
    # The recovered attempt is not a request of its own, though its row is summed.
    assert k1["requests"] == 3
    assert k1["errors"] == 1
    assert k1["cost"] == pytest.approx(0.04)
    assert k1["tokens"] == 15 * 3 + 105
    # The mean of the rows that recorded a latency.
    assert k1["latency_ms"] == pytest.approx((200 + 100 + 100) / 3)
    assert _instant(k1["first_at"]) == seeded["k1_old"]
    assert _instant(k1["last_at"]) == seeded["k1_new"]
    # Most requests first, ties by name; the absorbed attempt's model has none.
    assert k1["top_models"] == [{"model": "gpt-4o", "requests": 2}, {"model": "gpt-4o-mini", "requests": 1}]
    assert by_key[None]["label"] is None
    assert by_key[None]["requests"] == 1


@pytest.mark.parametrize(
    ("order", "expected"),
    [("recent", ["k2", "k1", None]), ("requests", ["k1", "k2", None]), ("cost", ["k2", "k1", None])],
)
def test_groups_rank_by_the_order_asked_for(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, datetime], order: str, expected: list[Any]
) -> None:
    body = _get(client, master_key_header, group_by="api_key", order=order)
    assert [group["key"] for group in body["groups"]] == expected


def test_groups_page_and_count_past_the_last_page(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, datetime]
) -> None:
    first = _get(client, master_key_header, group_by="api_key", limit=2)
    second = _get(client, master_key_header, group_by="api_key", limit=2, skip=2)
    assert [group["key"] for group in first["groups"] + second["groups"]] == ["k2", "k1", None]
    assert first["total"] == second["total"] == 3
    past = _get(client, master_key_header, group_by="api_key", limit=2, skip=10)
    assert (past["groups"], past["total"]) == ([], 3)


def test_groups_read_the_log_filters(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, datetime]
) -> None:
    body = _get(client, master_key_header, group_by="user", model="gpt-4o")
    groups = {group["key"]: group for group in body["groups"]}
    assert set(groups) == {"ada", "bob"}
    assert groups["ada"]["label"] == "Ada Person"
    assert groups["ada"]["requests"] == 2

    sessions = _get(client, master_key_header, group_by="source_label", status="error")
    assert [(group["key"], group["requests"]) for group in sessions["groups"]] == [(None, 1)]

    models = _get(client, master_key_header, group_by="model", order="requests")
    assert models["groups"][0]["key"] == "gpt-4o"
    assert models["groups"][0]["top_models"] == [{"model": "gpt-4o", "requests": 3}]


def test_an_unknown_grouping_is_refused(client: TestClient, master_key_header: dict[str, str]) -> None:
    response = client.get(GROUPED_PATH, headers=master_key_header, params={"group_by": "status"})
    assert response.status_code == 422
    response = client.get(GROUPED_PATH, headers=master_key_header, params={"group_by": "model", "order": "name"})
    assert response.status_code == 422
