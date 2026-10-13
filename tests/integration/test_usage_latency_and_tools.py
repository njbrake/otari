"""The summary's two slow parts, served on their own.

``/latency`` and ``/tools`` answer what ``/summary`` adds with ``include_p95``,
``p95_by`` and the ``tool`` dimension, so each must agree with the summary for the
same filters and window.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from conftest import seed_workspace_id
from gateway.core.config import API_ROOT
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog

USAGE = f"{API_ROOT}/usage"
T0 = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
WINDOW = {"start_date": (T0 - timedelta(hours=1)).isoformat(), "end_date": (T0 + timedelta(days=2)).isoformat()}


def _row(db: Session, **overrides: Any) -> None:
    fields: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "workspace_id": seed_workspace_id(db),
        "timestamp": T0,
        "model": "gpt-4",
        "provider": "openai",
        "endpoint": "/v1/chat/completions",
        "source": "gateway",
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "total_tokens": 110,
        "cost": 0.10,
        "status": "success",
    }
    fields.update(overrides)
    db.add(UsageLog(**fields))


def _get(client: TestClient, headers: dict[str, str], path: str, **params: Any) -> dict[str, Any]:
    response = client.get(f"{USAGE}/{path}", params={**WINDOW, **params}, headers=headers)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def test_the_windows_p95_matches_the_summarys_and_leaves_absorbed_attempts_out(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    for latency_ms in range(100, 2100, 100):
        _row(db_session, latency_ms=latency_ms)
    _row(db_session, latency_ms=90_000, status="absorbed", cost=None)
    db_session.commit()

    latency = _get(client, master_key_header, "latency")
    summary = _get(client, master_key_header, "summary", dimensions="none", include_p95="true")
    # Nearest rank: the 19th of 20 latencies.
    assert latency["p95_latency_ms"] == 1900
    assert latency["p95_latency_ms"] == summary["totals"]["p95_latency_ms"]
    assert latency["group_by"] is None
    assert latency["groups"] == []


def test_each_groups_p95_matches_the_summarys_null_group_included(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    db_session.add(APIKey(id="k-app", key_hash="hash-k-app", key_name="app", workspace_id=seed_workspace_id(db_session)))
    db_session.flush()
    _row(db_session, api_key_id="k-app", latency_ms=400, cost=1.0)
    _row(db_session, latency_ms=900)
    _row(db_session, latency_ms=1200)
    db_session.commit()

    latency = _get(client, master_key_header, "latency", group_by="api_key")
    summary = _get(client, master_key_header, "summary", dimensions="api_key", p95_by="api_key")
    assert latency["p95_latency_ms"] is None
    assert latency["group_by"] == "api_key"
    assert latency["groups"] == [
        {"key": row["key"], "p95_latency_ms": row["p95_latency_ms"]}
        for row in summary["by_api_key"]
        if not row["is_other"]
    ]
    assert {group["key"]: group["p95_latency_ms"] for group in latency["groups"]} == {"k-app": 400, None: 1200}


def test_the_groups_are_the_ones_the_summary_ranks_into_its_top_n(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gateway.services.usage import _summary as summary_rules

    monkeypatch.setitem(summary_rules.SUMMARY_BREAKDOWNS, "model", 2)
    _row(db_session, model="big", cost=3.0, latency_ms=300)
    _row(db_session, model="mid", cost=2.0, latency_ms=200)
    _row(db_session, model="small", cost=1.0, latency_ms=100)
    db_session.commit()

    by_cost = _get(client, master_key_header, "latency", group_by="model")
    assert [group["key"] for group in by_cost["groups"]] == ["big", "mid"]
    ascending = _get(client, master_key_header, "latency", group_by="model", rank_order="asc")
    assert [group["key"] for group in ascending["groups"]] == ["small", "mid"]
    # Ranked by p95, the groups and their values come from the ranking itself.
    by_p95 = _get(client, master_key_header, "latency", group_by="model", rank_by="p95", rank_order="asc")
    assert by_p95["groups"] == [{"key": "small", "p95_latency_ms": 100}, {"key": "mid", "p95_latency_ms": 200}]


def test_an_empty_window_has_no_latency(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert _get(client, master_key_header, "latency")["p95_latency_ms"] is None
    assert _get(client, master_key_header, "latency", group_by="model")["groups"] == []


def test_the_tools_match_the_summarys_by_tool(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(
        db_session,
        cost=0.05,
        billing_meters={
            "total_input_tokens": 10,
            "completion_tokens": 5,
            "tools": {"web_search": {"billed": 3, "errors": 1, "unit_rate": 0.01}},
        },
    )
    _row(db_session)
    db_session.commit()

    tools = _get(client, master_key_header, "tools")
    summary = _get(client, master_key_header, "summary", dimensions="tool")
    assert tools["tools"] == summary["by_tool"]
    assert [(row["tool"], row["calls"], row["errors"], row["requests"]) for row in tools["tools"]] == [
        ("web_search", 3, 1, 1)
    ]
    assert tools["start_date"] == summary["start_date"]


def test_a_window_with_no_tool_calls_lists_no_tools(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session)
    db_session.commit()

    assert _get(client, master_key_header, "tools")["tools"] == []
