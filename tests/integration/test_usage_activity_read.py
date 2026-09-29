"""The usage read surface the Activity page is built on.

Covers what the list, count and summary gained for it: free-text search, a lookup by
row id, the model name the caller sent, time to first token, recovered attempts folded
into the row that served, the percentile latency, the imported-cost split and the
five-minute series bucket. Each is asserted against the endpoint beside it that has to
agree with it (a list and its count, a filter and the bulk delete that re-derives it).
"""

from __future__ import annotations

import uuid
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from conftest import seed_workspace_id
from gateway.core.config import API_KEY_HEADER, API_ROOT, GatewayConfig
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User

from .conftest import build_test_client

USAGE = f"{API_ROOT}/usage"
T0 = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
ROW_ID = "0b8e5c1a-7d2f-4e3a-9c6b-1f2e3d4c5b6a"
REQUEST_ID = "3f9c2b7e-1d4a-4c8e-9b0f-5a6d7e8f9a0b"
# Around T0, which a substring search needs named: without a start it reads the
# last 30 days only.
WINDOW = {"start_date": (T0 - timedelta(hours=1)).isoformat(), "end_date": (T0 + timedelta(hours=1)).isoformat()}


def _user(db: Session, user_id: str, alias: str | None = None) -> None:
    if db.query(User).filter(User.user_id == user_id).first() is None:
        db.add(User(user_id=user_id, alias=alias or user_id, spend=0.0, blocked=False))
        db.flush()


def _row(db: Session, **overrides: object) -> UsageLog:
    user_id = str(overrides.pop("user_id", "u1"))
    _user(db, user_id)
    fields: dict[str, object] = {
        "id": str(uuid.uuid4()),
        "workspace_id": seed_workspace_id(db),
        "user_id": user_id,
        "timestamp": T0,
        "model": "claude-haiku-4-5",
        "provider": "anthropic",
        "endpoint": "/v1/messages",
        "prompt_tokens": 10,
        "completion_tokens": 5,
        "total_tokens": 15,
        "cost": 0.01,
        "status": "success",
        "source": "gateway",
        "counts_toward_budget": True,
    }
    fields.update(overrides)
    log = UsageLog(**fields)
    db.add(log)
    return log


def _ids(response_json: object) -> set[str]:
    assert isinstance(response_json, list)
    return {row["id"] for row in response_json}


# ---------------------------------------------------------------------------
# Row fields
# ---------------------------------------------------------------------------


def test_list_returns_requested_model_and_ttft(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, id="aliased", requested_model="fast", ttft_ms=240, latency_ms=900)
    _row(db_session, id="old", timestamp=T0 - timedelta(minutes=1))
    db_session.commit()

    body = {row["id"]: row for row in client.get(USAGE, headers=master_key_header).json()}
    assert body["aliased"]["requested_model"] == "fast"
    assert body["aliased"]["ttft_ms"] == 240
    # A row written before either was recorded reads as "not recorded", not as zero.
    assert body["old"]["requested_model"] is None
    assert body["old"]["ttft_ms"] is None


def test_requested_model_filter_finds_an_alias_by_the_name_the_caller_sent(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, id="via-alias", requested_model="fast")
    _row(db_session, id="direct", requested_model="claude-haiku-4-5")
    _row(db_session, id="unrecorded")
    db_session.commit()

    listed = client.get(USAGE, params={"requested_model": "fast"}, headers=master_key_header).json()
    assert _ids(listed) == {"via-alias"}
    count = client.get(f"{USAGE}/count", params={"requested_model": "fast"}, headers=master_key_header).json()
    assert count == {"total": 1}


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


@pytest.fixture
def searchable(db_session: Session) -> None:
    _user(db_session, "priya", alias="Priya S.")
    db_session.add(
        APIKey(
            id="key-support",
            key_hash="h-support",
            key_name="support-bot",
            user_id="priya",
            workspace_id=seed_workspace_id(db_session),
        )
    )
    db_session.flush()
    _row(db_session, id=ROW_ID, model="gpt-5.6-mini", provider="openai")
    _row(db_session, id="from-log", request_id=REQUEST_ID)
    _row(db_session, id="by-alias", requested_model="fast")
    _row(db_session, id="by-session", source_label="session-4c3260ca")
    _row(db_session, id="by-key", user_id="priya", api_key_id="key-support", model="claude-sonnet-5")
    _row(db_session, id="underscore", model="gpt_4")
    _row(db_session, id="wildcard-bait", model="gptx4")
    db_session.commit()


@pytest.mark.usefixtures("searchable")
@pytest.mark.parametrize(
    ("q", "expected"),
    [
        # A pasted UUID is an Otari-Request-ID or a row id, matched exactly...
        (REQUEST_ID, {"from-log"}),
        # In whatever form it was pasted.
        (REQUEST_ID.upper(), {"from-log"}),
        (REQUEST_ID.replace("-", ""), {"from-log"}),
        (ROW_ID, {ROW_ID}),
        # ...and a fragment of one matches neither, nor anything else.
        ("0b8e5c1a", set()),
        ("GPT-5.6", {ROW_ID}),
        ("fast", {"by-alias"}),
        ("4c3260", {"by-session"}),
        ("support", {"by-key"}),
        ("priya", {"by-key"}),
        # ``_`` is literal text, not a LIKE wildcard, so it does not also match "gptx4".
        ("gpt_4", {"underscore"}),
        ("   ", {ROW_ID, "from-log", "by-alias", "by-session", "by-key", "underscore", "wildcard-bait"}),
    ],
)
def test_search_matches_id_model_alias_session_key_and_member(
    client: TestClient, master_key_header: dict[str, str], q: str, expected: set[str]
) -> None:
    listed = client.get(USAGE, params={"q": q, **WINDOW}, headers=master_key_header).json()
    assert _ids(listed) == expected
    count = client.get(f"{USAGE}/count", params={"q": q, **WINDOW}, headers=master_key_header).json()
    assert count == {"total": len(expected)}


@pytest.mark.usefixtures("searchable")
def test_a_substring_search_without_a_start_reads_a_bounded_window(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    """No index serves a substring search, so it reads the last 30 days rather than the whole log."""
    listed = client.get(USAGE, params={"q": "gpt"}, headers=master_key_header).json()
    count = client.get(f"{USAGE}/count", params={"q": "gpt"}, headers=master_key_header).json()
    assert listed == [], "the fixture's rows are older than the default lookback"
    assert count == {"total": 0}, "the count reads the window its list does"


@pytest.mark.usefixtures("searchable")
def test_an_id_lookup_is_not_bounded(client: TestClient, master_key_header: dict[str, str]) -> None:
    """A pasted request id stays on its index, so it finds a row of any age."""
    listed = client.get(USAGE, params={"q": REQUEST_ID}, headers=master_key_header).json()
    count = client.get(f"{USAGE}/count", params={"q": REQUEST_ID}, headers=master_key_header).json()
    assert _ids(listed) == {"from-log"}
    assert count == {"total": 1}


def test_search_narrows_the_summary_the_same_way(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, model="gpt-5.6-mini", cost=0.5)
    _row(db_session, model="claude-haiku-4-5", cost=0.25)
    db_session.commit()

    summary = client.get(
        f"{USAGE}/summary",
        params={"q": "gpt", "start_date": (T0 - timedelta(days=1)).isoformat(), "dimensions": "none"},
        headers=master_key_header,
    ).json()
    assert summary["totals"]["request_count"] == 1
    assert summary["totals"]["cost"] == pytest.approx(0.5)


def test_search_is_length_bounded(client: TestClient, master_key_header: dict[str, str]) -> None:
    response = client.get(USAGE, params={"q": "x" * 201}, headers=master_key_header)
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Lookup by id
# ---------------------------------------------------------------------------


def test_id_filter_returns_exactly_the_named_rows(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, id="one")
    _row(db_session, id="two")
    _row(db_session, id="three")
    db_session.commit()

    listed = client.get(USAGE, params=[("id", "one"), ("id", "three")], headers=master_key_header).json()
    assert _ids(listed) == {"one", "three"}


def test_request_id_filter_returns_every_row_of_the_request(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, id="served", request_id=REQUEST_ID)
    _row(db_session, id="absorbed", request_id=REQUEST_ID, status="absorbed", cost=None)
    _row(db_session, id="other", request_id=str(uuid.uuid4()))
    db_session.commit()

    listed = client.get(USAGE, params={"request_id": REQUEST_ID}, headers=master_key_header).json()
    assert _ids(listed) == {"served", "absorbed"}


# ---------------------------------------------------------------------------
# Earlier failed attempts
# ---------------------------------------------------------------------------


@pytest.fixture
def fallover(db_session: Session) -> None:
    """One routed request that recovered from one failed attempt, and one plain request."""
    _row(
        db_session,
        id="absorbed",
        timestamp=T0,
        status="absorbed",
        status_code=529,
        cost=None,
        model="claude-opus-5-5",
        policy_name="opus-fallback",
        attempt_position=1,
        attempt_count=2,
        request_group_id="g1",
        latency_ms=2400,
    )
    _row(
        db_session,
        id="served",
        timestamp=T0 + timedelta(seconds=3),
        model="claude-sonnet-5",
        policy_name="opus-fallback",
        attempt_position=2,
        attempt_count=2,
        request_group_id="g1",
        latency_ms=5400,
    )
    _row(db_session, id="plain", timestamp=T0 - timedelta(minutes=1), latency_ms=800)
    db_session.commit()


@pytest.mark.usefixtures("fallover")
def test_listing_without_absorbed_rows_folds_them_into_the_row_that_served(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    listed = client.get(USAGE, params={"include_absorbed": "false"}, headers=master_key_header).json()
    by_id = {row["id"]: row for row in listed}
    assert set(by_id) == {"served", "plain"}
    assert by_id["served"]["absorbed_attempts"] == 1
    assert by_id["plain"]["absorbed_attempts"] == 0
    # The count pages the same set.
    count = client.get(f"{USAGE}/count", params={"include_absorbed": "false"}, headers=master_key_header).json()
    assert count == {"total": 2}


@pytest.mark.usefixtures("fallover")
def test_absorbed_rows_are_still_listed_by_default_and_by_an_explicit_status(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    # The default is unchanged for external consumers of the bare array.
    by_id = {row["id"]: row for row in client.get(USAGE, headers=master_key_header).json()}
    assert set(by_id) == {"absorbed", "served", "plain"}
    assert by_id["served"]["absorbed_attempts"] == 1
    assert by_id["absorbed"]["absorbed_attempts"] == 0
    # An explicit status wins over include_absorbed=false rather than contradicting it.
    listed = client.get(
        USAGE, params={"include_absorbed": "false", "status": "absorbed"}, headers=master_key_header
    ).json()
    assert _ids(listed) == {"absorbed"}


# ---------------------------------------------------------------------------
# Summary totals and series
# ---------------------------------------------------------------------------


def _summary(client: TestClient, headers: dict[str, str], **params: str) -> dict[str, object]:
    query: dict[str, str] = {
        "start_date": (T0 - timedelta(hours=1)).isoformat(),
        "end_date": (T0 + timedelta(hours=1)).isoformat(),
    }
    query.update(params)
    response = client.get(f"{USAGE}/summary", params=query, headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body, dict)
    return body


@pytest.mark.usefixtures("fallover")
def test_totals_count_absorbed_attempts_apart_from_requests(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    totals = _summary(client, master_key_header, dimensions="none")["totals"]
    assert isinstance(totals, dict)
    assert totals["request_count"] == 2
    assert totals["error_count"] == 0
    assert totals["absorbed_count"] == 1


def test_p95_is_the_nearest_rank_latency_and_only_computed_when_asked(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    # Twenty requests at 100..2000 ms: nearest rank ceil(0.95 * 20) = 19, so 1900.
    for i in range(1, 21):
        _row(db_session, latency_ms=i * 100, timestamp=T0 + timedelta(seconds=i))
    # Neither an absorbed attempt nor a row with no latency moves it.
    _row(db_session, status="absorbed", latency_ms=99_999, request_group_id="g", cost=None)
    _row(db_session, latency_ms=None)
    db_session.commit()

    requested = _summary(client, master_key_header, dimensions="none", include_p95="true")["totals"]
    assert isinstance(requested, dict)
    assert requested["p95_latency_ms"] == 1900
    skipped = _summary(client, master_key_header, dimensions="none")["totals"]
    assert isinstance(skipped, dict)
    assert skipped["p95_latency_ms"] is None


def test_p95_is_null_when_nothing_recorded_a_latency(client: TestClient, master_key_header: dict[str, str]) -> None:
    totals = _summary(client, master_key_header, dimensions="none", include_p95="true")["totals"]
    assert isinstance(totals, dict)
    assert totals["p95_latency_ms"] is None


def test_imported_cost_is_split_from_the_gateways_own(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, cost=0.25)
    _row(db_session, cost=0.40, source="claude_code", counts_toward_budget=False)
    # Budget-exempt gateway traffic is still the gateway's own spend, not imported.
    _row(db_session, cost=0.10, counts_toward_budget=False)
    db_session.commit()

    totals = _summary(client, master_key_header, dimensions="none")["totals"]
    assert isinstance(totals, dict)
    assert totals["cost"] == pytest.approx(0.75)
    assert totals["imported_cost"] == pytest.approx(0.40)


def test_five_minute_series_is_dense_and_on_the_five_minute_grid(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, timestamp=T0 + timedelta(minutes=1))
    _row(db_session, timestamp=T0 + timedelta(minutes=4, seconds=59))
    _row(db_session, timestamp=T0 + timedelta(minutes=12))
    db_session.commit()

    body = _summary(
        client,
        master_key_header,
        bucket="5min",
        dimensions="none",
        start_date=T0.isoformat(),
        end_date=(T0 + timedelta(minutes=20)).isoformat(),
    )
    assert body["bucket"] == "5min"
    series = body["series"]
    assert isinstance(series, list)
    assert [(p["bucket_start"], p["requests"]) for p in series] == [
        ("2026-07-01T09:00:00Z", 2),
        ("2026-07-01T09:05:00Z", 0),
        ("2026-07-01T09:10:00Z", 1),
        ("2026-07-01T09:15:00Z", 0),
    ]


def test_series_buckets_land_on_the_utc_grid_for_an_offset_start(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """A start written with an offset still floors to UTC bucket keys, so the zero-filled
    gaps line up with the populated buckets instead of forming a second grid."""
    _row(db_session, timestamp=T0)
    db_session.commit()

    body = _summary(
        client,
        master_key_header,
        bucket="hour",
        dimensions="none",
        start_date="2026-07-01T10:30:00+02:00",
        end_date="2026-07-01T11:00:00+00:00",
    )
    series = body["series"]
    assert isinstance(series, list)
    assert [(p["bucket_start"], p["requests"]) for p in series] == [
        ("2026-07-01T08:00:00Z", 0),
        ("2026-07-01T09:00:00Z", 1),
        ("2026-07-01T10:00:00Z", 0),
    ]


def test_five_minute_buckets_are_refused_over_a_window_too_wide_to_chart(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    # A thousand five-minute buckets is about 83 hours, so the default 30 days is refused.
    too_wide = client.get(f"{USAGE}/summary", params={"bucket": "5min"}, headers=master_key_header)
    assert too_wide.status_code == 422
    fits = client.get(
        f"{USAGE}/summary",
        params={"bucket": "5min", "start_date": T0.isoformat(), "end_date": (T0 + timedelta(hours=24)).isoformat()},
        headers=master_key_header,
    )
    assert fits.status_code == 200


def test_the_grouped_series_does_not_take_the_five_minute_bucket(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    response = client.get(f"{USAGE}/series", params={"group_by": "model", "bucket": "5min"}, headers=master_key_header)
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Bulk mutation agrees with the read filters
# ---------------------------------------------------------------------------


def test_bulk_delete_by_filter_honors_the_search(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    imported = {"source": "claude_code", "counts_toward_budget": False}
    _row(db_session, id="match", model="claude-opus-5-5", **imported)
    _row(db_session, id="other", model="claude-haiku-4-5", **imported)
    db_session.commit()

    counted = client.get(
        f"{USAGE}/count", params={"q": "opus", "counts_toward_budget": "false", **WINDOW}, headers=master_key_header
    ).json()
    assert counted == {"total": 1}
    deleted = client.request(
        "DELETE", USAGE, json={"by_filter": True, "q": "opus", **WINDOW}, headers=master_key_header
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {"deleted": counted["total"]}
    assert _ids(client.get(USAGE, headers=master_key_header).json()) == {"other"}


def test_a_bulk_delete_by_substring_search_reads_the_window_its_count_did(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """With no start, the count reads 30 days, so the delete it promised must touch no older row."""
    _row(db_session, id="old-match", model="claude-opus-5-5", source="claude_code", counts_toward_budget=False)
    db_session.commit()

    counted = client.get(
        f"{USAGE}/count", params={"q": "opus", "counts_toward_budget": "false"}, headers=master_key_header
    ).json()
    deleted = client.request("DELETE", USAGE, json={"by_filter": True, "q": "opus"}, headers=master_key_header)
    assert deleted.json() == {"deleted": counted["total"]} == {"deleted": 0}


# ---------------------------------------------------------------------------
# The pipeline records the name the caller sent
# ---------------------------------------------------------------------------


class _ProviderDown(Exception):
    """Stands in for any upstream failure; the failure row is what is asserted."""


@pytest.fixture
def alias_client(postgres_url: str) -> Generator[TestClient]:
    config = GatewayConfig(
        database_url=postgres_url,
        master_key="test-master-key",
        auto_migrate=False,
        require_pricing=False,
        model_discovery=False,
        providers={"anthropic": {"api_key": "sk-ant"}},
        aliases={"fast": "anthropic:claude-haiku-4-5"},
    )
    yield from build_test_client(config)


def test_a_request_through_an_alias_records_the_alias_as_requested(alias_client: TestClient) -> None:
    headers = {API_KEY_HEADER: "Bearer test-master-key"}
    assert (
        alias_client.post(f"{API_ROOT}/users", json={"user_id": "u1", "alias": "u1"}, headers=headers).status_code
        == 200
    )
    with patch("gateway.api.routes.chat.acompletion", new=AsyncMock(side_effect=_ProviderDown)):
        alias_client.post(
            f"{API_ROOT}/chat/completions",
            json={"model": "fast", "messages": [{"role": "user", "content": "Hi"}], "user": "u1"},
            headers=headers,
        )

    rows = alias_client.get(USAGE, headers=headers).json()
    assert len(rows) == 1
    assert rows[0]["model"] == "claude-haiku-4-5"
    assert rows[0]["requested_model"] == "fast"
