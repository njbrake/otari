"""Sorting, refinement filters and activity groups on the usage read surface.

What the Activity page's column headers and group-by lean on: every list can be
ordered by any column it shows, narrowed by exclusions and thresholds, and
collapsed into groups. Each read is checked against the endpoint that must agree
with it (the list and its count, a filter and the bulk delete that re-derives it).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from conftest import seed_workspace_id
from gateway.core.config import API_ROOT
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User

USAGE = f"{API_ROOT}/usage"
T0 = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
WINDOW = {"start_date": (T0 - timedelta(hours=1)).isoformat(), "end_date": (T0 + timedelta(hours=1)).isoformat()}


def _user(db: Session, user_id: str, alias: str) -> None:
    db.add(User(user_id=user_id, alias=alias, spend=0.0, blocked=False))
    db.flush()


def _key(db: Session, key_id: str, name: str, user_id: str) -> None:
    db.add(
        APIKey(id=key_id, key_hash=f"h-{key_id}", key_name=name, user_id=user_id, workspace_id=seed_workspace_id(db))
    )
    db.flush()


def _row(db: Session, row_id: str, **overrides: object) -> None:
    fields: dict[str, object] = {
        "id": row_id,
        "workspace_id": seed_workspace_id(db),
        "timestamp": T0,
        "model": "claude-haiku-4-5",
        "provider": "anthropic",
        "endpoint": "/v1/messages",
        "prompt_tokens": 100,
        "completion_tokens": 10,
        "total_tokens": 110,
        "cost": 0.01,
        "status": "success",
        "source": "gateway",
        "counts_toward_budget": True,
    }
    fields.update(overrides)
    db.add(UsageLog(**fields))


@pytest.fixture
def activity(db_session: Session) -> None:
    """Six rows that differ on every column the Activity table shows."""
    _user(db_session, "u-priya", "Priya S.")
    _user(db_session, "u-jordan", "jordan M.")
    _key(db_session, "k-support", "support-bot", "u-priya")
    _key(db_session, "k-laptop", "Jordan-laptop", "u-jordan")
    _row(
        db_session,
        "a",
        timestamp=T0 + timedelta(minutes=5),
        user_id="u-priya",
        api_key_id="k-support",
        model="gpt-5.6-mini",
        cost=0.002,
        latency_ms=600,
        policy_name="cheap-first",
        attempt_position=1,
        attempt_count=2,
        request_group_id="ga",
    )
    _row(
        db_session,
        "b",
        timestamp=T0 + timedelta(minutes=4),
        user_id="u-jordan",
        api_key_id="k-laptop",
        model="Claude-Sonnet-5",
        cost=0.041,
        latency_ms=5400,
        prompt_tokens=40_000,
        policy_name="opus-fallback",
        attempt_position=2,
        attempt_count=2,
        request_group_id="gb",
    )
    _row(
        db_session,
        "c",
        timestamp=T0 + timedelta(minutes=3),
        user_id="u-jordan",
        api_key_id="k-laptop",
        status="error",
        status_code=429,
        cost=None,
        latency_ms=None,
    )
    _row(db_session, "d", timestamp=T0 + timedelta(minutes=2), cost=None, latency_ms=900, prompt_tokens=900_000)
    _row(
        db_session,
        "e",
        timestamp=T0 + timedelta(minutes=1),
        source="claude_code",
        counts_toward_budget=False,
        cost=0.45,
        latency_ms=8000,
        source_label="s-1",
    )
    _row(
        db_session,
        "f",
        timestamp=T0,
        user_id="u-jordan",
        api_key_id="k-laptop",
        model="claude-opus-5-5",
        status="absorbed",
        status_code=529,
        cost=None,
        latency_ms=2400,
        policy_name="opus-fallback",
        attempt_position=1,
        attempt_count=2,
        request_group_id="gb",
    )
    db_session.commit()


def _order(client: TestClient, headers: dict[str, str], **params: str) -> list[str]:
    response = client.get(USAGE, params={**WINDOW, **params}, headers=headers)
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()]


def _ids(client: TestClient, headers: dict[str, str], params: list[tuple[str, str]]) -> set[str]:
    response = client.get(USAGE, params=[*WINDOW.items(), *params], headers=headers)
    assert response.status_code == 200, response.text
    listed = {row["id"] for row in response.json()}
    count = client.get(f"{USAGE}/count", params=[*WINDOW.items(), *params], headers=headers)
    assert count.json() == {"total": len(listed)}
    return listed


# ---------------------------------------------------------------------------
# Sorting
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("activity")
@pytest.mark.parametrize(
    ("sort", "order", "expected"),
    [
        ("timestamp", "desc", ["a", "b", "c", "d", "e", "f"]),
        ("timestamp", "asc", ["f", "e", "d", "c", "b", "a"]),
        # Rows with no cost or latency sort last in both directions, newest first among them.
        ("cost", "desc", ["e", "b", "a", "c", "d", "f"]),
        ("cost", "asc", ["a", "b", "e", "c", "d", "f"]),
        ("latency", "asc", ["a", "d", "f", "b", "e", "c"]),
        ("tokens", "desc", ["d", "b", "a", "c", "e", "f"]),
        # Case-insensitive, so "Claude-Sonnet-5" sorts beside its lowercase neighbors.
        ("model", "asc", ["c", "d", "e", "f", "b", "a"]),
        # The key's name when there is one, else the provenance source.
        ("source", "asc", ["e", "d", "b", "c", "f", "a"]),
        ("member", "asc", ["b", "c", "f", "a", "d", "e"]),
        ("policy", "asc", ["a", "b", "f", "c", "d", "e"]),
        # Failures, then recovered (an absorbed attempt, or a request served after a fallback), then successes.
        ("status", "desc", ["c", "b", "f", "a", "d", "e"]),
    ],
)
def test_the_list_sorts_by_every_column_it_shows(
    client: TestClient, master_key_header: dict[str, str], sort: str, order: str, expected: list[str]
) -> None:
    assert _order(client, master_key_header, sort=sort, order=order) == expected


@pytest.mark.usefixtures("activity")
def test_a_sorted_list_pages_without_repeating_or_skipping_a_row(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    pages = [
        _order(client, master_key_header, sort="policy", order="asc", skip=str(skip), limit="2") for skip in (0, 2, 4)
    ]
    assert [row for page in pages for row in page] == ["a", "b", "f", "c", "d", "e"]


@pytest.mark.usefixtures("activity")
def test_a_list_sorted_by_anything_but_time_reads_a_bounded_window(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    """With no start, a sorted page reads the summary's default lookback rather than the whole log."""
    newest_first = client.get(USAGE, headers=master_key_header).json()
    by_cost = client.get(USAGE, params={"sort": "cost"}, headers=master_key_header).json()
    assert len(newest_first) == 6
    assert by_cost == [], "the fixture's rows are older than the default lookback"


@pytest.mark.usefixtures("activity")
@pytest.mark.parametrize("window", [{}, WINDOW])
def test_a_sorted_list_and_its_count_read_the_same_window(
    client: TestClient, master_key_header: dict[str, str], window: dict[str, str]
) -> None:
    """The count reads the window the list did, so a paginator's total is the total of its pages."""
    params = {**window, "sort": "cost"}
    listed = client.get(USAGE, params=params, headers=master_key_header).json()
    count = client.get(f"{USAGE}/count", params=params, headers=master_key_header).json()
    assert count == {"total": len(listed)}


def test_an_unknown_sort_is_rejected(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert client.get(USAGE, params={"sort": "prompt"}, headers=master_key_header).status_code == 422


# ---------------------------------------------------------------------------
# Refinements
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("activity")
@pytest.mark.parametrize(
    ("params", "expected"),
    [
        ([("exclude_model", "claude-haiku-4-5")], {"a", "b", "f"}),
        # Rows with no billed user are not "Jordan's", so excluding Jordan keeps them.
        ([("exclude_user_id", "u-jordan")], {"a", "d", "e"}),
        ([("exclude_api_key_id", "k-laptop"), ("exclude_api_key_id", "k-support")], {"d", "e"}),
        ([("exclude_source", "claude_code")], {"a", "b", "c", "d", "f"}),
        ([("exclude_status", "error"), ("exclude_status", "absorbed")], {"a", "b", "d", "e"}),
        ([("policy_name", "opus-fallback")], {"b", "f"}),
        # Unrouted rows are not served by the excluded policy, so they stay.
        ([("exclude_policy_name", "opus-fallback")], {"a", "c", "d", "e"}),
        ([("routed", "true")], {"a", "b", "f"}),
        ([("routed", "false")], {"c", "d", "e"}),
        ([("is_null", "api_key_id")], {"d", "e"}),
        ([("is_null", "source_label"), ("is_null", "user_id")], {"d"}),
        # Thresholds are strict: "more than", as the menu reads.
        ([("cost_gt", "0.041")], {"e"}),
        ([("tokens_gt", "40010")], {"d"}),
        ([("latency_ms_gt", "5400")], {"e"}),
    ],
)
def test_refinements_narrow_the_list_and_its_count_alike(
    client: TestClient, master_key_header: dict[str, str], params: list[tuple[str, str]], expected: set[str]
) -> None:
    assert _ids(client, master_key_header, params) == expected


@pytest.mark.usefixtures("activity")
def test_refinements_narrow_the_summary(client: TestClient, master_key_header: dict[str, str]) -> None:
    summary = client.get(
        f"{USAGE}/summary", params={**WINDOW, "routed": "false", "dimensions": "none"}, headers=master_key_header
    ).json()
    assert summary["totals"]["request_count"] == 3
    assert summary["totals"]["error_count"] == 1


@pytest.mark.parametrize(
    "params",
    [
        [("cost_gt", "-1")],
        [("exclude_status", "pending")],
        [("is_null", "model")],
        [("exclude_model", f"m{i}") for i in range(51)],
        # The token and latency columns are 32-bit; past that is a 422, not a database error.
        [("tokens_gt", str(2**31))],
        [("latency_ms_gt", str(2**31))],
        # Past the cost column's range, or not finite, a threshold cannot be bound to it.
        [("cost_gt", "1e12")],
        [("cost_gt", "1e30")],
        [("cost_gt", "inf")],
        [("cost_gt", "nan")],
    ],
)
def test_refinements_are_validated(
    client: TestClient, master_key_header: dict[str, str], params: list[tuple[str, str]]
) -> None:
    assert client.get(USAGE, params=tuple(params), headers=master_key_header).status_code == 422


def test_the_largest_cost_threshold_is_read(client: TestClient, master_key_header: dict[str, str]) -> None:
    response = client.get(USAGE, params={"cost_gt": "999999999999"}, headers=master_key_header)
    assert response.status_code == 200, response.text
    assert response.json() == []


@pytest.mark.parametrize("cost_gt", ["1e30", "Infinity", "NaN"])
def test_a_bulk_cost_threshold_is_validated(
    client: TestClient, master_key_header: dict[str, str], cost_gt: str
) -> None:
    # Raw JSON: Python's encoder writes inf and nan as bare Infinity and NaN, which is what a client could send.
    body = f'{{"by_filter": true, "cost_gt": {cost_gt}}}'
    headers = {**master_key_header, "Content-Type": "application/json"}
    assert client.request("DELETE", USAGE, content=body, headers=headers).status_code == 422


def test_bulk_set_price_by_filter_honors_the_refinements(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    imported = {"source": "claude_code", "counts_toward_budget": False, "cost": None}
    _row(db_session, "slow", latency_ms=9000, **imported)
    _row(db_session, "quick", latency_ms=500, **imported)
    db_session.commit()

    priced = client.post(
        f"{USAGE}/set-price",
        json={
            "by_filter": True,
            **WINDOW,
            "latency_ms_gt": 5000,
            "input_price_per_million": 1.0,
            "output_price_per_million": 1.0,
        },
        headers=master_key_header,
    )
    assert priced.status_code == 200, priced.text
    costs = {row["id"]: row["cost"] for row in client.get(USAGE, headers=master_key_header).json()}
    assert costs["slow"] is not None
    assert costs["quick"] is None


def test_bulk_delete_by_filter_honors_the_refinements(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    imported = {"source": "claude_code", "counts_toward_budget": False}
    _row(db_session, "cheap", cost=0.10, **imported)
    _row(db_session, "dear", cost=0.90, **imported)
    _row(db_session, "dear-opus", cost=0.95, model="claude-opus-5-5", **imported)
    db_session.commit()
    params = {**WINDOW, "cost_gt": "0.5", "exclude_model": "claude-opus-5-5", "counts_toward_budget": "false"}

    counted = client.get(f"{USAGE}/count", params=params, headers=master_key_header).json()
    deleted = client.request(
        "DELETE",
        USAGE,
        # One value, as the entity filters take it, rather than a list of one.
        json={"by_filter": True, **WINDOW, "cost_gt": 0.5, "exclude_model": "claude-opus-5-5"},
        headers=master_key_header,
    )
    assert deleted.status_code == 200, deleted.text
    assert counted == {"total": 1}
    assert deleted.json() == {"deleted": 1}
    assert {row["id"] for row in client.get(USAGE, headers=master_key_header).json()} == {"cheap", "dear-opus"}


# ---------------------------------------------------------------------------
# Activity groups
# ---------------------------------------------------------------------------


def _groups(client: TestClient, headers: dict[str, str], **params: str) -> Any:
    response = client.get(f"{USAGE}/groups", params={**WINDOW, **params}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.usefixtures("activity")
def test_groups_by_api_key_carry_what_the_group_row_shows(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _groups(client, master_key_header, group_by="api_key")
    assert body["total"] == 3
    groups = body["groups"]
    # Most recently active first.
    assert [(g["key"], g["label"]) for g in groups] == [
        ("k-support", "support-bot"),
        ("k-laptop", "Jordan-laptop"),
        (None, None),
    ]
    laptop = groups[1]
    assert laptop["requests"] == 2  # the absorbed attempt is not a request
    assert laptop["errors"] == 1
    assert laptop["absorbed"] == 1
    assert laptop["cost"] == pytest.approx(0.041)
    assert laptop["imported_cost"] == 0
    assert laptop["input_tokens"] == 40_000 + 100 + 100
    assert laptop["latency_ms"] == 5400  # summed over requests; the absorbed attempt's 2400 is not model time
    assert laptop["first_at"].startswith("2026-07-01T09:00:00")
    assert laptop["last_at"].startswith("2026-07-01T09:04:00")
    # The two most-used; the absorbed attempt's model served no request, so it is
    # only counted, in the "+N".
    assert set(laptop["models"]) == {"Claude-Sonnet-5", "claude-haiku-4-5"}
    assert laptop["model_count"] == 3
    keyless = groups[2]
    assert keyless["requests"] == 2
    assert keyless["imported_cost"] == pytest.approx(0.45)


@pytest.mark.usefixtures("activity")
def test_a_group_without_a_key_is_listed_through_is_null(client: TestClient, master_key_header: dict[str, str]) -> None:
    keyless = [g for g in _groups(client, master_key_header, group_by="api_key")["groups"] if g["key"] is None]
    listed = _ids(client, master_key_header, [("is_null", "api_key_id")])
    assert keyless[0]["requests"] == len(listed)


@pytest.mark.usefixtures("activity")
def test_groups_page_and_follow_the_filters(client: TestClient, master_key_header: dict[str, str]) -> None:
    first = _groups(client, master_key_header, group_by="model", limit="2")
    second = _groups(client, master_key_header, group_by="model", limit="2", skip="2")
    assert first["total"] == second["total"] == 4
    keys = [g["key"] for g in [*first["groups"], *second["groups"]]]
    assert keys == ["gpt-5.6-mini", "Claude-Sonnet-5", "claude-haiku-4-5", "claude-opus-5-5"]
    narrowed = _groups(client, master_key_header, group_by="model", routed="true")
    assert {g["key"] for g in narrowed["groups"]} == {"gpt-5.6-mini", "Claude-Sonnet-5", "claude-opus-5-5"}


@pytest.mark.usefixtures("activity")
def test_a_groups_page_past_the_end_is_empty(client: TestClient, master_key_header: dict[str, str]) -> None:
    body = _groups(client, master_key_header, group_by="api_key", skip="10")
    assert body["groups"] == []
    assert body["total"] == 3


@pytest.mark.usefixtures("activity")
def test_groups_filtered_to_absorbed_attempts_count_the_attempts(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    """As everywhere else, filtering to absorbed rows makes them the unit counted."""
    body = _groups(client, master_key_header, group_by="api_key", status="absorbed")
    assert [(g["key"], g["requests"], g["absorbed"]) for g in body["groups"]] == [("k-laptop", 1, 1)]


@pytest.mark.usefixtures("activity")
def test_groups_by_policy_match_the_policy_filters(client: TestClient, master_key_header: dict[str, str]) -> None:
    """A policy group holds that policy's requests, and the group with no policy the direct ones."""
    groups = _groups(client, master_key_header, group_by="policy")["groups"]
    assert groups, "the fixture routes some requests"
    for group in groups:
        filters = [("routed", "false")] if group["key"] is None else [("policy_name", group["key"])]
        listed = _ids(client, master_key_header, [*filters, ("include_absorbed", "false")])
        assert group["requests"] == len(listed), group["key"]
    assert any(group["key"] is None for group in groups)


def test_groups_by_alias_hold_only_the_names_that_were_aliases(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """A name that is the model, in any form, or the routing policy is not an alias."""
    _row(db_session, "fast-1", requested_model="fast")
    _row(db_session, "fast-2", timestamp=T0 + timedelta(minutes=1), requested_model="fast")
    _row(db_session, "bare", requested_model="claude-haiku-4-5")
    _row(db_session, "qualified", requested_model="anthropic:claude-haiku-4-5")
    _row(db_session, "slashed", requested_model="anthropic/claude-haiku-4-5")
    _row(db_session, "policy", requested_model="cheap-first", policy_name="cheap-first")
    _row(db_session, "unnamed")
    db_session.commit()

    groups = _groups(client, master_key_header, group_by="alias")
    assert [(group["key"], group["requests"]) for group in groups["groups"]] == [("fast", 2)]
    assert groups["total"] == 1
    assert _ids(client, master_key_header, [("requested_model", "fast")]) == {"fast-1", "fast-2"}


@pytest.mark.usefixtures("activity")
def test_groups_search_the_value_and_the_name_it_resolves_to(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    """A column menu's search runs on the server, so it finds groups past the page it lists."""
    by_name = _groups(client, master_key_header, group_by="api_key", search="SUPPORT")
    assert [g["key"] for g in by_name["groups"]] == ["k-support"]
    assert by_name["total"] == 1
    by_value = _groups(client, master_key_header, group_by="model", search="opus")
    assert [g["key"] for g in by_value["groups"]] == ["claude-opus-5-5"]
    # A wildcard is literal text.
    assert _groups(client, master_key_header, group_by="model", search="%")["total"] == 0


@pytest.mark.usefixtures("activity")
def test_groups_list_the_busiest_first_when_asked(client: TestClient, master_key_header: dict[str, str]) -> None:
    recent = _groups(client, master_key_header, group_by="api_key")
    busiest = _groups(client, master_key_header, group_by="api_key", order="requests")
    requests = [g["requests"] for g in busiest["groups"]]
    assert requests == sorted(requests, reverse=True)
    assert {g["key"] for g in busiest["groups"]} == {g["key"] for g in recent["groups"]}
    assert busiest["groups"][0]["key"] == "k-laptop"


def test_groups_require_a_known_dimension(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert client.get(f"{USAGE}/groups", params={"group_by": "endpoint"}, headers=master_key_header).status_code == 422


@pytest.mark.parametrize("operation", ["delete", "set-price"])
def test_a_bulk_selection_by_filter_reads_the_window_its_sorted_count_did(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, operation: str
) -> None:
    """A count sorted by cost with no start reads 30 days, so the mutation it sized touches no older row."""
    imported = {"source": "claude_code", "counts_toward_budget": False, "cost": None}
    _row(db_session, "old", **imported)
    _row(db_session, "recent", timestamp=datetime.now(UTC) - timedelta(days=1), **imported)
    db_session.commit()

    counted = client.get(
        f"{USAGE}/count", params={"sort": "cost", "counts_toward_budget": "false"}, headers=master_key_header
    ).json()
    assert counted == {"total": 1}
    if operation == "delete":
        response = client.request("DELETE", USAGE, json={"by_filter": True, "sort": "cost"}, headers=master_key_header)
        assert response.json() == {"deleted": 1}
        assert {row["id"] for row in client.get(USAGE, headers=master_key_header).json()} == {"old"}
    else:
        rates = {"input_price_per_million": 1.0, "output_price_per_million": 1.0}
        response = client.post(
            f"{USAGE}/set-price", json={"by_filter": True, "sort": "cost", **rates}, headers=master_key_header
        )
        assert response.json()["matched"] == 1
        costs = {row["id"]: row["cost"] for row in client.get(USAGE, headers=master_key_header).json()}
        assert costs == {"old": None, "recent": pytest.approx(0.00011)}
