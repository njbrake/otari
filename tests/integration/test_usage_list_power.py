"""Sorting the usage list, searching it, and the filters and totals the request log reads beside them.

Runs against the PostgreSQL the suite is configured for. Parity between the
rollups and the rows for the filters here is pinned in ``test_usage_rollups.py``,
and tenant scoping on the organization routes in
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
from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT, UsageLog
from gateway.models.users import User

LIST_PATH = f"{API_ROOT}/usage"
COUNT_PATH = f"{API_ROOT}/usage/count"
SUMMARY_PATH = f"{API_ROOT}/usage/summary"
SERIES_PATH = f"{API_ROOT}/usage/series"
GROUPS_PATH = f"{API_ROOT}/usage/groups"

_GROUP = "8c0c3a49-6f4b-4f38-9d0e-3f6f0b3b6e1a"


def _log(
    db: Session,
    *,
    row_id: str | None = None,
    minutes_ago: int,
    model: str = "gpt-4o",
    requested_model: str | None = None,
    user_id: str | None = "ada",
    api_key_id: str | None = None,
    status: str = "success",
    cost: str | None = "0.01",
    prompt_tokens: int = 10,
    completion_tokens: int = 5,
    latency_ms: int | None = 100,
    policy_name: str | None = None,
    source: str = "gateway",
    source_label: str | None = None,
    endpoint: str = "/v1/chat/completions",
    request_group_id: str | None = None,
    attempt_position: int | None = None,
) -> str:
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
    row_id = row_id or str(uuid.uuid4())
    db.add(
        UsageLog(
            id=row_id,
            workspace_id=workspace_id,
            user_id=user_id,
            api_key_id=api_key_id,
            timestamp=datetime.now(UTC) - timedelta(minutes=minutes_ago),
            model=model,
            requested_model=requested_model,
            provider="openai",
            endpoint=endpoint,
            source=source,
            source_label=source_label,
            counts_toward_budget=source == "gateway",
            status=status,
            error_message="boom" if status == "error" else None,
            cost=Decimal(cost) if cost is not None else None,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            latency_ms=latency_ms,
            policy_name=policy_name,
            request_group_id=request_group_id or str(uuid.uuid4()),
            attempt_position=attempt_position,
        )
    )
    return row_id


@pytest.fixture
def seeded(db_session: Session) -> dict[str, str]:
    """Seven rows a minute apart, newest first: one of each status, channel and empty column."""
    ids = {
        "a": _log(db_session, minutes_ago=1, user_id="zed", api_key_id="k1", cost="0.30", latency_ms=900),
        "b": _log(
            db_session,
            minutes_ago=2,
            model="claude",
            requested_model="fast-alias",
            user_id="ada",
            api_key_id="k2",
            status="success",
            policy_name="fast",
            cost="0.05",
            latency_ms=300,
            request_group_id=_GROUP,
            attempt_position=2,
            prompt_tokens=4000,
        ),
        "c": _log(
            db_session,
            minutes_ago=3,
            model="gpt-4o",
            user_id="ada",
            api_key_id="k2",
            status="absorbed",
            policy_name="fast",
            cost=None,
            latency_ms=5000,
            request_group_id=_GROUP,
            attempt_position=1,
        ),
        "d": _log(db_session, minutes_ago=4, user_id="bob", status="error", cost=None, latency_ms=50),
        "e": _log(
            db_session,
            minutes_ago=5,
            model="claude",
            user_id="bob",
            status="incomplete",
            cost="0.02",
            latency_ms=None,
            endpoint=PLAYGROUND_USAGE_ENDPOINT,
        ),
        "f": _log(
            db_session,
            minutes_ago=6,
            model="claude-sonnet",
            user_id=None,
            source="claude-code",
            source_label="Refactor session",
            cost="1.00",
            latency_ms=200,
        ),
        "g": _log(db_session, minutes_ago=7, user_id="ada", cost=None, latency_ms=700),
    }
    db_session.commit()
    return ids


def _get(client: TestClient, headers: dict[str, str], path: str, **params: Any) -> Any:
    response = client.get(path, headers=headers, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _ids(client: TestClient, headers: dict[str, str], seeded: dict[str, str], **params: Any) -> str:
    """The rows a list read returns, by their fixture letter, in order."""
    by_id = {row_id: letter for letter, row_id in seeded.items()}
    return "".join(by_id[row["id"]] for row in _get(client, headers, LIST_PATH, **params))


def _count(client: TestClient, headers: dict[str, str], **params: Any) -> int:
    return int(_get(client, headers, COUNT_PATH, **params)["total"])


# =============================================================================
# Sorting
# =============================================================================


@pytest.mark.parametrize(
    ("sort", "order", "expected"),
    [
        ("timestamp", "desc", "abcdefg"),
        ("timestamp", "asc", "gfedcba"),
        # No cost sorts last in either direction; ties fall back to newest first.
        ("cost", "desc", "fabecdg"),
        ("cost", "asc", "ebafcdg"),
        ("latency", "desc", "cagbfde"),
        ("latency", "asc", "dfbgace"),
        # Failures, then the incomplete request, then the recovered attempt and the
        # request served after one, then clean successes.
        ("status", "desc", "debcafg"),
        ("model", "asc", "befacdg"),
        # By alias: Ada Person, Bob Person, Zed Person, then the row with no user.
        ("user", "asc", "bcgdeaf"),
        # By key name, or the provenance source where no key made the row.
        ("source", "asc", "fdegabc"),
        ("policy", "asc", "bcadefg"),
        ("input_tokens", "desc", "bacdefg"),
    ],
)
def test_a_sort_orders_the_whole_window_and_breaks_ties_newest_first(
    client: TestClient,
    master_key_header: dict[str, str],
    seeded: dict[str, str],
    sort: str,
    order: str,
    expected: str,
) -> None:
    assert _ids(client, master_key_header, seeded, sort=sort, order=order) == expected


def test_a_sort_pages_without_repeating_or_skipping_a_row(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str]
) -> None:
    pages = [
        _ids(client, master_key_header, seeded, sort="cost", order="desc", skip=skip, limit=2) for skip in (0, 2, 4, 6)
    ]
    assert "".join(pages) == "fabecdg"


def test_an_unknown_sort_key_or_order_is_refused(client: TestClient, master_key_header: dict[str, str]) -> None:
    for params in ({"sort": "error_message"}, {"order": "sideways"}):
        assert client.get(LIST_PATH, headers=master_key_header, params=params).status_code == 422


def test_a_sort_bounds_an_open_window_and_the_count_says_the_same(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, seeded: dict[str, str]
) -> None:
    """Any order but time reads the summary's window, so its pages and its count leave out older rows alike."""
    _log(db_session, minutes_ago=60 * 24 * 40)
    db_session.commit()
    assert len(_get(client, master_key_header, LIST_PATH)) == 8
    assert _count(client, master_key_header) == 8
    assert len(_get(client, master_key_header, LIST_PATH, sort="cost")) == 7
    assert _count(client, master_key_header, sort="cost") == 7


# =============================================================================
# Search
# =============================================================================


@pytest.mark.parametrize(
    ("q", "expected"),
    [
        # The served model, and the name the caller sent.
        ("SONNET", "f"),
        ("fast-al", "b"),
        # The session label and the provenance source.
        ("refactor", "f"),
        ("claude-code", "f"),
        # The billed user's id and alias, and the API key's name.
        ("zed", "a"),
        ("bob pers", "de"),
        ("k2 lap", "bc"),
        # A substring, not a pattern.
        ("%", ""),
    ],
)
def test_a_search_matches_the_small_text_columns_and_the_names_behind_ids(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str], q: str, expected: str
) -> None:
    assert _ids(client, master_key_header, seeded, q=q) == expected
    assert _count(client, master_key_header, q=q) == len(expected)


def test_a_uuid_search_matches_a_row_id_or_a_request_id_exactly(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str]
) -> None:
    assert _ids(client, master_key_header, seeded, q=seeded["d"]) == "d"
    assert _ids(client, master_key_header, seeded, q=f"  {_GROUP.upper()} ") == "bc"
    assert _ids(client, master_key_header, seeded, q=str(uuid.uuid4())) == ""


def test_a_search_narrows_every_aggregate_alike(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str]
) -> None:
    summary = _get(client, master_key_header, SUMMARY_PATH, q="claude", dimensions="model")
    assert {group["key"] for group in summary["by_model"]} == {"claude", "claude-sonnet"}
    series = _get(client, master_key_header, SERIES_PATH, q="claude", group_by="model")
    assert {group["key"] for group in series["groups"]} == {"claude", "claude-sonnet"}
    groups = _get(client, master_key_header, GROUPS_PATH, q="claude", group_by="user")
    assert {group["key"] for group in groups["groups"]} == {"ada", "bob", None}


def test_a_search_longer_than_the_cap_is_refused(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert client.get(LIST_PATH, headers=master_key_header, params={"q": "x" * 201}).status_code == 422


# =============================================================================
# Ways in, empty columns, recovered attempts and status subsets
# =============================================================================


@pytest.mark.usefixtures("seeded")
def test_a_channel_is_read_off_the_source_and_the_endpoint(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    assert _count(client, master_key_header, channel="imported") == 1
    assert _count(client, master_key_header, channel="playground") == 1
    assert _count(client, master_key_header, channel="api") == 5
    assert _count(client, master_key_header, channel=["api", "playground"]) == 6
    assert client.get(COUNT_PATH, headers=master_key_header, params={"channel": "email"}).status_code == 422


def test_is_null_keeps_the_rows_with_nothing_in_a_column(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str]
) -> None:
    assert _ids(client, master_key_header, seeded, is_null="user") == "f"
    assert _ids(client, master_key_header, seeded, is_null="api_key") == "defg"
    assert _ids(client, master_key_header, seeded, is_null=["api_key", "session"]) == "deg"


def test_include_absorbed_false_lists_each_request_once_unless_a_status_says_otherwise(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str]
) -> None:
    assert _ids(client, master_key_header, seeded, include_absorbed="false") == "abdefg"
    assert _ids(client, master_key_header, seeded, include_absorbed="false", status="absorbed") == "c"
    assert _ids(client, master_key_header, seeded, include_absorbed="false", statuses=["absorbed", "error"]) == "cd"
    summary = _get(client, master_key_header, SUMMARY_PATH, include_absorbed="false", dimensions="none")
    assert summary["totals"]["absorbed_count"] == 0
    assert summary["totals"]["request_count"] == 6


def test_statuses_keep_a_subset_and_one_absorbed_status_counts_attempts(
    client: TestClient, master_key_header: dict[str, str], seeded: dict[str, str]
) -> None:
    assert _ids(client, master_key_header, seeded, statuses=["error", "incomplete"]) == "de"
    totals = _get(client, master_key_header, SUMMARY_PATH, statuses="absorbed", dimensions="none")["totals"]
    assert totals["request_count"] == 1
    assert client.get(COUNT_PATH, headers=master_key_header, params={"statuses": "lost"}).status_code == 422


# =============================================================================
# Totals
# =============================================================================


@pytest.mark.usefixtures("seeded")
def test_the_totals_count_recovered_incomplete_and_imported_and_p95_only_when_asked(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    totals = _get(client, master_key_header, SUMMARY_PATH, dimensions="none")["totals"]
    assert totals["request_count"] == 6
    assert totals["error_count"] == 1
    assert totals["absorbed_count"] == 1
    assert totals["incomplete_count"] == 1
    assert totals["cost"] == pytest.approx(1.37)
    assert totals["imported_cost"] == pytest.approx(1.0)
    assert totals["p95_latency_ms"] is None

    asked = _get(client, master_key_header, SUMMARY_PATH, dimensions="none", include_p95="true")["totals"]
    # The requests' latencies, the absorbed attempt and the missing one left out:
    # 50, 200, 300, 700, 900, interpolated at 95% of the way.
    assert asked["p95_latency_ms"] == 860
    narrowed = _get(client, master_key_header, SUMMARY_PATH, dimensions="none", include_p95="true", model="claude")
    assert narrowed["totals"]["p95_latency_ms"] == 300


def test_p95_is_empty_over_a_window_with_no_latency(client: TestClient, master_key_header: dict[str, str]) -> None:
    totals = _get(client, master_key_header, SUMMARY_PATH, dimensions="none", include_p95="true")["totals"]
    assert totals["p95_latency_ms"] is None
