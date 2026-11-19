"""The refinement filters (exclusions, routing, thresholds) and the values a filter menu lists.

Runs against the PostgreSQL the suite is configured for. Parity between the
rollups and the rows for the same filters is pinned in ``test_usage_rollups.py``;
these pin what each filter means at the HTTP surface.
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

LIST_PATH = f"{API_ROOT}/usage"
COUNT_PATH = f"{API_ROOT}/usage/count"
SUMMARY_PATH = f"{API_ROOT}/usage/summary"
GROUPS_PATH = f"{API_ROOT}/usage/groups"


def _log(
    db: Session,
    *,
    model: str = "gpt-4o",
    user_id: str | None = "ada",
    api_key_id: str | None = None,
    status: str = "success",
    cost: str | None = "0.01",
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    latency_ms: int | None = 100,
    policy_name: str | None = None,
) -> None:
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
    db.add(
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=workspace_id,
            user_id=user_id,
            api_key_id=api_key_id,
            timestamp=datetime.now(UTC) - timedelta(minutes=30),
            model=model,
            provider="openai",
            endpoint="/v1/chat/completions",
            status=status,
            error_message="boom" if status == "error" else None,
            cost=Decimal(cost) if cost is not None else None,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            latency_ms=latency_ms,
            policy_name=policy_name,
            request_group_id=str(uuid.uuid4()),
        )
    )


@pytest.fixture
def seeded(db_session: Session) -> None:
    _log(db_session, model="gpt-4o", user_id="ada", api_key_id="k1", cost="0.50", latency_ms=4000)
    _log(db_session, model="gpt-4o", user_id="ada", api_key_id="k1", status="error", cost=None)
    _log(db_session, model="gpt-4o", user_id="bob", api_key_id="k2", policy_name="fast", prompt_tokens=5000)
    _log(db_session, model="claude", user_id="bob", api_key_id="k2", status="absorbed", policy_name="fast")
    _log(db_session, model="claude", user_id=None, api_key_id=None, policy_name="cheap", cost="2.00")
    db_session.commit()


def _get(client: TestClient, headers: dict[str, str], path: str, **params: Any) -> Any:
    response = client.get(path, headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _count(client: TestClient, headers: dict[str, str], **params: Any) -> int:
    return int(_get(client, headers, COUNT_PATH, **params)["total"])


@pytest.mark.usefixtures("seeded")
def test_exclusions_leave_out_their_values_and_keep_the_rows_with_none(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    assert _count(client, master_key_header) == 5
    assert _count(client, master_key_header, exclude_model="claude") == 3
    # The row with no billed user is not one of Ada's, so it stays.
    assert _count(client, master_key_header, exclude_user_id="ada") == 3
    assert _count(client, master_key_header, exclude_api_key_id=["k1", "k2"]) == 1
    assert _count(client, master_key_header, exclude_status=["absorbed", "error"]) == 3
    # An include and an exclusion on one column compose.
    assert _count(client, master_key_header, model=["gpt-4o", "claude"], exclude_model="gpt-4o") == 2
    listed = _get(client, master_key_header, LIST_PATH, exclude_status="error")
    assert {row["status"] for row in listed} == {"success", "absorbed"}


@pytest.mark.usefixtures("seeded")
def test_exclusions_narrow_the_summary_as_they_do_the_list(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _get(client, master_key_header, SUMMARY_PATH, exclude_model="claude", dimensions="model")
    assert [group["key"] for group in body["by_model"]] == ["gpt-4o"]
    assert body["totals"]["request_count"] == 3


@pytest.mark.usefixtures("seeded")
def test_routing_filters_read_the_policy_a_request_was_served_through(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    assert _count(client, master_key_header, routed="true") == 3
    assert _count(client, master_key_header, routed="false") == 2
    assert _count(client, master_key_header, policy_name="fast") == 2
    # Rows served without a policy are not served through "fast", so they stay.
    assert _count(client, master_key_header, exclude_policy_name="fast") == 3


@pytest.mark.usefixtures("seeded")
def test_thresholds_keep_the_rows_above_them(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert _count(client, master_key_header, tokens_gt=1000) == 1
    assert _count(client, master_key_header, cost_gt=0.4) == 2
    assert _count(client, master_key_header, latency_ms_gt=1000) == 1
    body = _get(client, master_key_header, SUMMARY_PATH, cost_gt=1, dimensions="none")
    assert body["totals"]["cost"] == pytest.approx(2.0)


@pytest.mark.parametrize(
    "params",
    [{"tokens_gt": -1}, {"latency_ms_gt": 2**31}, {"cost_gt": "inf"}, {"exclude_status": "bogus"}],
)
def test_a_threshold_or_status_out_of_range_is_refused(
    client: TestClient, master_key_header: dict[str, str], params: dict[str, Any]
) -> None:
    assert client.get(COUNT_PATH, headers=master_key_header, params=params).status_code == 422


@pytest.mark.usefixtures("seeded")
def test_groups_list_a_columns_values_busiest_first_with_how_many_there_are(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _get(client, master_key_header, GROUPS_PATH, group_by="model")
    assert body["group_by"] == "model"
    assert body["total"] == 2
    # Requests, not rows: the absorbed attempt is not a request of its own.
    assert [(group["key"], group["requests"], group["errors"]) for group in body["groups"]] == [
        ("gpt-4o", 3, 1),
        ("claude", 1, 0),
    ]
    page = _get(client, master_key_header, GROUPS_PATH, group_by="model", limit=1)
    assert [group["key"] for group in page["groups"]] == ["gpt-4o"]
    assert page["total"] == 2
    second = _get(client, master_key_header, GROUPS_PATH, group_by="model", limit=1, skip=1)
    assert [group["key"] for group in second["groups"]] == ["claude"]


@pytest.mark.usefixtures("seeded")
def test_groups_name_users_and_keys_and_find_them_by_name(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    users = _get(client, master_key_header, GROUPS_PATH, group_by="user")
    assert {(group["key"], group["label"]) for group in users["groups"]} == {
        ("ada", "Ada Person"),
        ("bob", "Bob Person"),
        (None, None),
    }
    by_alias = _get(client, master_key_header, GROUPS_PATH, group_by="user", search="bob pers")
    assert [group["key"] for group in by_alias["groups"]] == ["bob"]
    by_id = _get(client, master_key_header, GROUPS_PATH, group_by="user", search="AD")
    assert [group["key"] for group in by_id["groups"]] == ["ada"]
    keys = _get(client, master_key_header, GROUPS_PATH, group_by="api_key", search="k2 lap")
    assert [(group["key"], group["label"]) for group in keys["groups"]] == [("k2", "k2 laptop")]
    # A search is a substring, not a pattern.
    assert _get(client, master_key_header, GROUPS_PATH, group_by="model", search="%")["total"] == 0


@pytest.mark.usefixtures("seeded")
def test_groups_by_status_count_rows_and_by_policy_keep_the_unrouted(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    statuses = _get(client, master_key_header, GROUPS_PATH, group_by="status")
    assert {group["key"]: group["requests"] for group in statuses["groups"]} == {
        "success": 3,
        "error": 1,
        "absorbed": 1,
    }
    policies = _get(client, master_key_header, GROUPS_PATH, group_by="policy")
    assert {group["key"]: group["requests"] for group in policies["groups"]} == {
        "fast": 1,
        None: 2,
        "cheap": 1,
    }


@pytest.mark.usefixtures("seeded")
def test_groups_honor_the_other_filters_and_refinements(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _get(client, master_key_header, GROUPS_PATH, group_by="user", model="gpt-4o", exclude_status="error")
    assert {group["key"]: group["requests"] for group in body["groups"]} == {"ada": 1, "bob": 1}
    above = _get(client, master_key_header, GROUPS_PATH, group_by="model", cost_gt=1)
    assert [group["key"] for group in above["groups"]] == ["claude"]


def test_groups_refuse_an_unknown_column_and_need_the_operator(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    assert client.get(GROUPS_PATH, headers=master_key_header, params={"group_by": "tag"}).status_code == 422
    assert client.get(GROUPS_PATH, params={"group_by": "model"}).status_code == 401
