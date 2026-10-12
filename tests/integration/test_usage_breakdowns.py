"""What each summary breakdown row carries beyond spend, and the breakdowns the Usage page added.

A breakdown row reconciles with the totals on every figure it reports, so the page
can split a group's spend into billed and imported, count its failures and its
cache reads, and rank its latency without a second request per row.
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
from gateway.models.tenancy import Workspace
from gateway.models.usage import PLAYGROUND_USAGE_ENDPOINT, UsageLog

SUMMARY = f"{API_ROOT}/usage/summary"
SERIES = f"{API_ROOT}/usage/series"
T0 = datetime(2026, 7, 1, 9, 0, tzinfo=UTC)
WINDOW = {"start_date": (T0 - timedelta(hours=1)).isoformat(), "end_date": (T0 + timedelta(days=2)).isoformat()}


def _key(db: Session, key_id: str, name: str) -> None:
    db.add(APIKey(id=key_id, key_hash=f"hash-{key_id}", key_name=name, workspace_id=seed_workspace_id(db)))
    db.flush()


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


def _summary(client: TestClient, headers: dict[str, str], **params: Any) -> dict[str, Any]:
    response = client.get(SUMMARY, params={**WINDOW, **params}, headers=headers)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _rows(body: dict[str, Any], field: str) -> dict[str | None, dict[str, Any]]:
    return {row["key"]: row for row in body[field] if not row["is_other"]}


def test_a_breakdown_row_splits_its_spend_and_counts_its_failures_and_cache_reads(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, model="opus", cost=1.0, source="claude_code", cache_read_tokens=80)
    _row(db_session, model="opus", cost=0.5, cache_read_tokens=20)
    _row(db_session, model="opus", cost=None, status="error", status_code=429)
    _row(db_session, model="haiku", cost=0.25)
    db_session.commit()

    body = _summary(client, master_key_header, dimensions="model")
    opus = _rows(body, "by_model")["opus"]
    assert opus["cost"] == pytest.approx(1.5)
    assert opus["imported_cost"] == pytest.approx(1.0)
    assert opus["error_count"] == 1
    assert opus["cache_read_tokens"] == 100
    assert opus["p95_latency_ms"] is None
    assert _rows(body, "by_model")["haiku"]["imported_cost"] == 0
    assert body["totals"]["billed_cache_read_tokens"] == 100


def test_the_fold_row_reconciles_the_new_figures_with_the_totals(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gateway.services.usage import _summary as summary_rules

    monkeypatch.setitem(summary_rules.SUMMARY_BREAKDOWNS, "model", 1)
    _row(db_session, model="big", cost=2.0)
    _row(db_session, model="small", cost=0.5, source="claude_code", cache_read_tokens=30)
    _row(db_session, model="smaller", cost=None, status="error")
    db_session.commit()

    body = _summary(client, master_key_header, dimensions="model", p95_by="model")
    fold = next(row for row in body["by_model"] if row["is_other"])
    assert fold["imported_cost"] == pytest.approx(0.5)
    assert fold["error_count"] == 1
    assert fold["cache_read_tokens"] == 30
    assert fold["p95_latency_ms"] is None


def test_p95_by_ranks_each_groups_latency_and_leaves_absorbed_attempts_out(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    for latency in range(100, 2100, 100):
        _row(db_session, model="steady", latency_ms=latency)
    # An abandoned attempt took far longer, and is not a request.
    _row(db_session, model="steady", latency_ms=90_000, status="absorbed", cost=None)
    _row(db_session, model="once", latency_ms=700)
    _row(db_session, model="unmeasured", latency_ms=None)
    db_session.commit()

    by_model = _rows(_summary(client, master_key_header, dimensions="model", p95_by="model"), "by_model")
    # Nearest rank: the 19th of 20 latencies.
    assert by_model["steady"]["p95_latency_ms"] == 1900
    assert by_model["once"]["p95_latency_ms"] == 700
    assert by_model["unmeasured"]["p95_latency_ms"] is None
    # Asked for one breakdown, so the other carries none.
    other = _summary(client, master_key_header, dimensions=["model", "provider"], p95_by="provider")
    assert all(row["p95_latency_ms"] is None for row in other["by_model"])
    assert _rows(other, "by_provider")["openai"]["p95_latency_ms"] == 1900


def test_p95_by_ranks_the_group_with_no_value_too(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """Requests with no key form the null group, and get their own p95."""
    _key(db_session, "k-app", "app")
    _row(db_session, api_key_id="k-app", latency_ms=400)
    _row(db_session, latency_ms=900)
    _row(db_session, latency_ms=1200)
    db_session.commit()

    by_key = _rows(_summary(client, master_key_header, dimensions="api_key", p95_by="api_key"), "by_api_key")
    assert by_key["k-app"]["p95_latency_ms"] == 400
    assert by_key[None]["p95_latency_ms"] == 1200


def test_p95_by_over_an_empty_window_has_no_groups_to_rank(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    body = _summary(client, master_key_header, dimensions="model", p95_by="model")
    assert body["by_model"] == []


def test_session_details_with_only_unlabeled_requests_names_no_session(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """Requests sent without a session id are the null group, which has no origin to report."""
    _row(db_session, source="claude_code")
    db_session.commit()

    body = _summary(client, master_key_header, dimensions="source_label", session_details="true")
    (row,) = body["by_source_label"]
    assert row["key"] is None
    assert row["source"] is None
    assert row["api_key_name"] is None


def test_a_breakdown_by_policy_groups_direct_requests_under_no_key(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, policy_name="cheap-first")
    _row(db_session, policy_name="cheap-first")
    _row(db_session)
    db_session.commit()

    by_policy = _rows(_summary(client, master_key_header, dimensions="policy"), "by_policy")
    assert {key: row["requests"] for key, row in by_policy.items()} == {"cheap-first": 2, None: 1}


def test_a_breakdown_by_channel_tells_imported_playground_and_api_apart(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, source="claude_code")
    _row(db_session, source="otari-ai:claude_code")
    _row(db_session, endpoint=PLAYGROUND_USAGE_ENDPOINT)
    _row(db_session, endpoint="/v1/messages")
    db_session.commit()

    by_channel = _rows(_summary(client, master_key_header, dimensions="channel"), "by_channel")
    assert {key: row["requests"] for key, row in by_channel.items()} == {"imported": 2, "playground": 1, "api": 1}
    assert by_channel["imported"]["imported_cost"] == pytest.approx(0.2)


def test_the_hosted_playgrounds_forwarding_key_counts_as_the_playground(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    """A hosted control plane forwards the Playground under a key it was minted, with the API's endpoint label."""
    db_session.add(
        APIKey(
            id="k-forward",
            key_hash="hash-forward",
            key_name="forward",
            workspace_id=seed_workspace_id(db_session),
            internal_secret="minted",
        )
    )
    _key(db_session, "k-app", "app")
    db_session.flush()
    _row(db_session, api_key_id="k-forward")
    _row(db_session, api_key_id="k-app")
    db_session.commit()

    by_channel = _rows(_summary(client, master_key_header, dimensions="channel"), "by_channel")
    assert {key: row["requests"] for key, row in by_channel.items()} == {"playground": 1, "api": 1}


def _channel_rows(db: Session) -> None:
    """One request in each way in: two imported, one typed in each Playground shape, one API call."""
    db.add(
        APIKey(
            id="k-forward",
            key_hash="hash-forward",
            key_name="forward",
            workspace_id=seed_workspace_id(db),
            internal_secret="minted",
        )
    )
    db.flush()
    _row(db, source="claude_code")
    _row(db, source="otari-ai:claude_code")
    _row(db, endpoint=PLAYGROUND_USAGE_ENDPOINT)
    _row(db, api_key_id="k-forward")
    _row(db, endpoint="/v1/messages")
    db.commit()


@pytest.mark.parametrize(
    ("params", "requests"),
    [
        ({"channel": "imported"}, 2),
        ({"channel": "playground"}, 2),
        ({"channel": "api"}, 1),
        ({"channel": ["api", "playground"]}, 3),
        ({"exclude_channel": "imported"}, 3),
    ],
)
def test_a_channel_filter_keeps_the_rows_the_channel_breakdown_counts(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session: Session,
    params: dict[str, Any],
    requests: int,
) -> None:
    """The filter and the breakdown share one rule, the hosted Playground's forwarding key included."""
    _channel_rows(db_session)

    assert _summary(client, master_key_header, **params)["totals"]["request_count"] == requests
    listed = client.get(f"{API_ROOT}/usage", params={**WINDOW, **params}, headers=master_key_header)
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == requests


def test_an_unknown_channel_is_refused(client: TestClient, master_key_header: dict[str, str]) -> None:
    response = client.get(SUMMARY, params={**WINDOW, "channel": "email"}, headers=master_key_header)
    assert response.status_code == 422


def test_a_breakdown_by_workspace_names_each_workspace(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    seed = db_session.get(Workspace, seed_workspace_id(db_session))
    assert seed is not None
    other = Workspace(name="Research", organization_id=seed.organization_id)
    db_session.add(other)
    db_session.flush()
    _row(db_session)
    _row(db_session, workspace_id=other.id)
    _row(db_session, workspace_id=other.id)
    db_session.commit()

    by_workspace = _rows(_summary(client, master_key_header, dimensions="workspace"), "by_workspace")
    assert by_workspace[str(other.id)]["label"] == "Research"
    assert by_workspace[str(other.id)]["requests"] == 2
    assert by_workspace[str(seed.id)]["label"] == seed.name


def test_a_session_row_carries_its_span_and_where_it_came_from_when_asked(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _key(db_session, "k-cc", "Claude Code")
    _row(db_session, source_label="s-1", source="claude_code", api_key_id="k-cc", timestamp=T0)
    _row(db_session, source_label="s-1", source="claude_code", api_key_id="k-cc", timestamp=T0 + timedelta(hours=3))
    _row(db_session, source_label="s-1", source="gateway", timestamp=T0 + timedelta(hours=1))
    # Abandoned attempts are not requests, so they cannot outvote the session's own.
    for _ in range(3):
        _row(db_session, source_label="s-1", source="gateway", status="absorbed", cost=None)
    _row(db_session, source_label=None)
    db_session.commit()

    plain = _rows(_summary(client, master_key_header, dimensions="source_label"), "by_source_label")
    assert datetime.fromisoformat(plain["s-1"]["first_at"]) == T0
    assert datetime.fromisoformat(plain["s-1"]["last_at"]) == T0 + timedelta(hours=3)
    assert plain["s-1"]["source"] is None
    assert plain["s-1"]["api_key_name"] is None

    detailed = _rows(
        _summary(client, master_key_header, dimensions="source_label", session_details="true"), "by_source_label"
    )
    assert detailed["s-1"]["source"] == "claude_code"
    assert detailed["s-1"]["api_key_name"] == "Claude Code"
    assert detailed[None]["source"] is None
    # Only sessions carry them.
    assert "first_at" not in _summary(client, master_key_header, dimensions="model")["by_model"][0]

    # Filtered to the abandoned attempts, those are what the session is made of.
    absorbed = _rows(
        _summary(client, master_key_header, dimensions="source_label", session_details="true", status="absorbed"),
        "by_source_label",
    )
    assert absorbed["s-1"]["source"] == "gateway"


def test_series_points_carry_their_imported_cost(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, cost=1.0, source="claude_code")
    _row(db_session, cost=0.25)
    db_session.commit()

    summary = _summary(client, master_key_header, dimensions="none")
    populated = [point for point in summary["series"] if point["requests"]]
    assert [(point["cost"], point["imported_cost"]) for point in populated] == [(1.25, 1.0)]
    grouped = client.get(SERIES, params={**WINDOW, "group_by": "channel"}, headers=master_key_header).json()
    by_key = {point["key"]: point for point in grouped["points"]}
    assert by_key["imported"]["imported_cost"] == pytest.approx(1.0)
    assert by_key["api"]["imported_cost"] == 0


@pytest.mark.parametrize(
    ("group_by", "field", "value"),
    [
        ("source_label", "source_label", "s-9"),
        ("provider", "provider", "fireworks"),
        ("policy", "policy_name", "thymeline"),
    ],
)
def test_the_series_splits_by_the_breakdowns_the_page_offers(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, group_by: str, field: str, value: str
) -> None:
    _row(db_session, **{field: value})
    _row(db_session)
    db_session.commit()

    response = client.get(SERIES, params={**WINDOW, "group_by": group_by}, headers=master_key_header)
    assert response.status_code == 200, response.text
    assert value in {point["key"] for point in response.json()["points"]}


def test_the_series_splits_by_workspace(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session)
    db_session.commit()

    body = client.get(SERIES, params={**WINDOW, "group_by": "workspace"}, headers=master_key_header).json()
    assert {point["key"] for point in body["points"]} == {str(seed_workspace_id(db_session))}


def _ranked_fixture(db: Session) -> None:
    """Three models on which every ranking disagrees.

    ``pricey``: one request, the most spend, all of it imported. ``busy``: the most
    requests, little spend. ``chatty``: the most tokens, middling billed spend.
    """
    _row(db, model="pricey", cost=5.0, source="claude_code", prompt_tokens=10, completion_tokens=0)
    for _ in range(4):
        _row(db, model="busy", cost=0.05, prompt_tokens=10, completion_tokens=0)
    _row(db, model="chatty", cost=1.0, prompt_tokens=50_000, completion_tokens=1_000)
    _row(db, model="chatty", cost=1.0, prompt_tokens=50_000, completion_tokens=1_000)
    db.commit()


@pytest.mark.parametrize(
    ("rank_by", "order"),
    [
        ("cost", ["pricey", "chatty", "busy"]),
        ("billed", ["chatty", "busy", "pricey"]),
        ("tokens", ["chatty", "busy", "pricey"]),
        ("requests", ["busy", "chatty", "pricey"]),
    ],
)
def test_rank_by_orders_every_breakdown(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, rank_by: str, order: list[str]
) -> None:
    _ranked_fixture(db_session)
    body = _summary(client, master_key_header, dimensions="model", rank_by=rank_by)
    assert [row["key"] for row in body["by_model"]] == order


def test_the_default_ranking_is_spend(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _ranked_fixture(db_session)
    assert (
        _summary(client, master_key_header, dimensions="model")["by_model"]
        == _summary(client, master_key_header, dimensions="model", rank_by="cost")["by_model"]
    )


def test_the_folds_top_n_follows_rank_by(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gateway.services.usage import _summary as summary_rules

    monkeypatch.setitem(summary_rules.SUMMARY_BREAKDOWNS, "model", 1)
    _ranked_fixture(db_session)

    by_cost = _summary(client, master_key_header, dimensions="model", rank_by="cost")["by_model"]
    by_requests = _summary(client, master_key_header, dimensions="model", rank_by="requests")["by_model"]
    assert [row["key"] for row in by_cost if not row["is_other"]] == ["pricey"]
    assert [row["key"] for row in by_requests if not row["is_other"]] == ["busy"]
    # The fold is whatever the kept group leaves, so it still reconciles either way.
    assert next(row for row in by_requests if row["is_other"])["requests"] == 3


def test_the_series_top_groups_follow_rank_by(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    # Nine models, so one folds: the one with the least of whatever ranks them.
    _row(db_session, model="pricey", cost=5.0)
    for index in range(8):
        for _ in range(2):
            _row(db_session, model=f"busy-{index}", cost=0.01)
    db_session.commit()

    def kept(rank_by: str) -> set[str]:
        response = client.get(
            SERIES, params={**WINDOW, "group_by": "model", "rank_by": rank_by}, headers=master_key_header
        )
        assert response.status_code == 200, response.text
        return {group["key"] for group in response.json()["groups"] if not group["is_other"]}

    assert "pricey" in kept("cost")
    assert kept("requests") == {f"busy-{index}" for index in range(8)}


def _sortable_fixture(db: Session) -> None:
    """Four models every sortable column of the Usage table orders differently.

    ``alpha``: one failure, p95 200 (an absorbed attempt that took far longer left
    out). ``Beta``: all imported, p95 300, capitalized so a case-sensitive name order
    would put it first. ``gamma``: two failures, p95 900. ``delta``: no latency at all.
    """
    _row(db, model="alpha", cost=0.1, latency_ms=100)
    _row(db, model="alpha", cost=None, status="error", latency_ms=200)
    _row(db, model="alpha", cost=None, status="absorbed", latency_ms=99_999)
    _row(db, model="Beta", cost=0.5, source="claude_code", latency_ms=300)
    _row(db, model="gamma", cost=0.2, latency_ms=50)
    _row(db, model="gamma", cost=None, status="error", latency_ms=900)
    _row(db, model="gamma", cost=None, status="error", latency_ms=900)
    _row(db, model="delta", cost=0.05, latency_ms=None)
    db.commit()


@pytest.mark.parametrize(
    ("rank_by", "rank_order", "order"),
    [
        ("imported", "desc", ["Beta", "alpha", "delta", "gamma"]),
        ("imported", "asc", ["alpha", "delta", "gamma", "Beta"]),
        ("errors", "desc", ["gamma", "alpha", "Beta", "delta"]),
        ("errors", "asc", ["Beta", "delta", "alpha", "gamma"]),
        ("name", "asc", ["alpha", "Beta", "delta", "gamma"]),
        ("name", "desc", ["gamma", "delta", "Beta", "alpha"]),
        # A group with no latency to rank comes last whichever way the rest go.
        ("p95", "desc", ["gamma", "Beta", "alpha", "delta"]),
        ("p95", "asc", ["alpha", "Beta", "gamma", "delta"]),
        ("cost", "asc", ["delta", "alpha", "gamma", "Beta"]),
    ],
)
def test_rank_by_and_rank_order_order_a_breakdown_by_any_column_the_table_sorts(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session: Session,
    rank_by: str,
    rank_order: str,
    order: list[str],
) -> None:
    _sortable_fixture(db_session)
    body = _summary(client, master_key_header, dimensions="model", rank_by=rank_by, rank_order=rank_order)
    assert [row["key"] for row in body["by_model"]] == order


def test_ranking_by_p95_carries_each_rows_p95_in_every_breakdown(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _sortable_fixture(db_session)
    body = _summary(client, master_key_header, dimensions=["model", "provider"], rank_by="p95", p95_by="provider")
    assert {row["key"]: row["p95_latency_ms"] for row in body["by_model"]} == {
        "alpha": 200,
        "Beta": 300,
        "gamma": 900,
        "delta": None,
    }
    assert _rows(body, "by_provider")["openai"]["p95_latency_ms"] == 900


def test_a_group_the_spend_ranking_folds_comes_back_ranked_by_failures(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    from gateway.services.usage._summary import BREAKDOWN_TOP_N

    for index in range(BREAKDOWN_TOP_N):
        _row(db_session, model=f"spender-{index:03}", cost=1.0)
    _row(db_session, model="flaky", cost=None, status="error")
    db_session.commit()

    by_cost = _summary(client, master_key_header, dimensions="model")["by_model"]
    assert "flaky" not in {row["key"] for row in by_cost}
    assert by_cost[-1]["is_other"] and by_cost[-1]["error_count"] == 1

    by_errors = _summary(client, master_key_header, dimensions="model", rank_by="errors")["by_model"]
    assert by_errors[0]["key"] == "flaky"
    assert by_errors[0]["error_count"] == 1
    assert by_errors[-1]["is_other"] and by_errors[-1]["error_count"] == 0


def test_ascending_keeps_the_bottom_of_the_ranking_and_folds_the_rest(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gateway.services.usage import _summary as summary_rules

    monkeypatch.setitem(summary_rules.SUMMARY_BREAKDOWNS, "model", 2)
    _ranked_fixture(db_session)

    by_model = _summary(client, master_key_header, dimensions="model", rank_by="cost", rank_order="asc")["by_model"]
    assert [(row["key"], row["is_other"]) for row in by_model] == [("busy", False), ("chatty", False), (None, True)]
    assert by_model[-1]["cost"] == pytest.approx(5.0)


@pytest.mark.parametrize("rank_order", ["desc", "asc"])
def test_a_tie_puts_the_group_with_no_key_last_in_either_direction(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, rank_order: str
) -> None:
    _key(db_session, "k-app", "app")
    _row(db_session, api_key_id="k-app")
    _row(db_session)
    db_session.commit()

    body = _summary(client, master_key_header, dimensions="api_key", rank_order=rank_order)
    assert [row["key"] for row in body["by_api_key"]] == ["k-app", None]


@pytest.mark.parametrize(("rank_order", "order"), [("asc", ["k-b", "k-a", None]), ("desc", ["k-a", "k-b", None])])
def test_ranking_by_name_reads_a_groups_label_where_it_has_one(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, rank_order: str, order: list[Any]
) -> None:
    """``k-a`` is named "zebra" and ``k-b`` "Apple", so the name order is the reverse of the key's."""
    _key(db_session, "k-a", "zebra")
    _key(db_session, "k-b", "Apple")
    _row(db_session, api_key_id="k-a")
    _row(db_session, api_key_id="k-b")
    _row(db_session)
    db_session.commit()

    body = _summary(client, master_key_header, dimensions="api_key", rank_by="name", rank_order=rank_order)
    assert [row["key"] for row in body["by_api_key"]] == order


def test_an_unknown_rank_is_refused(client: TestClient, master_key_header: dict[str, str]) -> None:
    for params in ({"rank_by": "latency"}, {"rank_order": "up"}):
        assert client.get(SUMMARY, params={**WINDOW, **params}, headers=master_key_header).status_code == 422


def test_the_series_groups_carry_no_p95(
    client: TestClient, master_key_header: dict[str, str], db_session: Session
) -> None:
    _row(db_session, latency_ms=100)
    db_session.commit()

    response = client.get(SERIES, params={**WINDOW, "group_by": "model"}, headers=master_key_header)
    assert response.status_code == 200, response.text
    assert all("p95_latency_ms" not in group for group in response.json()["groups"])


@pytest.mark.parametrize("rank_by", ["imported", "errors", "name", "p95"])
@pytest.mark.parametrize("rank_order", ["desc", "asc"])
def test_every_breakdown_ranks_by_every_column(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, rank_by: str, rank_order: str
) -> None:
    """The channel's CASE, the workspace's UUID and the labeled keys all order and group in one pass."""
    _key(db_session, "k-app", "app")
    _row(db_session, api_key_id="k-app", source_label="s1", latency_ms=100, policy_name="p")
    _row(db_session, source="claude_code", latency_ms=300)
    _row(db_session, endpoint=PLAYGROUND_USAGE_ENDPOINT, status="error", cost=None)
    db_session.commit()

    body = _summary(client, master_key_header, rank_by=rank_by, rank_order=rank_order)
    for field in ("by_model", "by_api_key", "by_source_label", "by_policy", "by_workspace", "by_channel"):
        assert sum(row["requests"] for row in body[field]) == 3, field
