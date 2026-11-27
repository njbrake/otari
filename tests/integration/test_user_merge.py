"""``POST /api/v1/users/{user_id}/merge``: one request-plane user folded into another.

The case it exists for: keys and usage recorded under an id typed before sign-in
existed (``legacy-id``), beside the attribution row a sign-in account mints under
its identity's UUID. After the merge the account holds the keys and the history,
and the old id is retired.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session
from sqlmodel import col

from gateway.core.config import API_ROOT
from gateway.models.api_keys import APIKey
from gateway.models.budgets import Budget, BudgetReservation, BudgetResetLog
from gateway.models.files import FileObject
from gateway.models.inference import BatchRecord, IdempotencyRecord, VideoJobRecord
from gateway.models.providers import ModelAlias, ProviderEndpoint
from gateway.models.routing import RoutingPolicy, SubagentDecision
from gateway.models.tenancy import Organization, OrganizationMember, Workspace
from gateway.models.tenancy import User as Identity
from gateway.models.tools import (
    McpOAuthFlow,
    McpUserConnection,
    SandboxContainer,
    WorkspaceMcpServer,
    WorkspaceMcpServerGrant,
)
from gateway.models.traces import Trace
from gateway.models.usage import AgentTelemetry, AgentTelemetryUserBarrier, UsageLog
from gateway.models.users import User
from gateway.services.tenancy.provisioning_service import DEFAULT_WORKSPACE_NAME
from gateway.services.tools import _user_merge as user_merge_listeners

LEGACY = "legacy-id"


@dataclass
class _World:
    workspace_id: uuid.UUID
    # The sign-in account's attribution user: its identity's UUID as a string.
    account: str


@pytest.fixture
def world(client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]) -> _World:
    assert client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK

    session = db_session_factory()
    try:
        workspace = session.execute(select(Workspace).where(col(Workspace.name) == DEFAULT_WORKSPACE_NAME)).scalar_one()
        identity = Identity(email="pat@example.com", full_name="Pat", active_organization_id=workspace.organization_id)
        session.add(identity)
        session.commit()
        session.refresh(identity)
        session.add(
            OrganizationMember(
                organization_id=workspace.organization_id, user_id=identity.id, role="member", status="active"
            )
        )
        account = str(identity.id)
        session.add_all(
            [
                User(user_id=account, alias="pat@example.com", spend=Decimal("1.50"), current_requests=2),
                User(
                    user_id=LEGACY, alias="Pat (old id)", spend=Decimal("2.25"), current_requests=3, current_tokens=40
                ),
            ]
        )
        session.commit()
        session.add_all(
            [
                APIKey(
                    id=str(uuid.uuid4()),
                    workspace_id=workspace.id,
                    key_hash="hash-legacy-1",
                    key_prefix="gw-legacy1",
                    user_id=LEGACY,
                ),
                APIKey(
                    id=str(uuid.uuid4()),
                    workspace_id=workspace.id,
                    key_hash="hash-legacy-2",
                    key_prefix="gw-legacy2",
                    user_id=LEGACY,
                ),
                UsageLog(
                    id=str(uuid.uuid4()),
                    workspace_id=workspace.id,
                    user_id=LEGACY,
                    model="m",
                    provider="p",
                    endpoint="/v1/chat/completions",
                    source="gateway",
                    status="success",
                    total_tokens=10,
                    # Outside the window in which the user counts as still sending requests.
                    timestamp=datetime.now(UTC) - timedelta(hours=1),
                ),
                ModelAlias(
                    name="fast",
                    target="openai:gpt-4o-mini",
                    workspace_id=workspace.id,
                    user_id=LEGACY,
                    updated_at=datetime.now(UTC),
                ),
            ]
        )
        session.commit()
        return _World(workspace_id=workspace.id, account=account)
    finally:
        session.close()


def _merge(client: TestClient, header: dict[str, str], *, target: str, source: str, preview: bool = False) -> Any:
    return client.post(
        f"{API_ROOT}/users/{target}/merge", json={"source_user_id": source, "preview": preview}, headers=header
    )


def _owners(session_factory: Callable[[], Session], model: type) -> list[str]:
    session = session_factory()
    try:
        return list(session.execute(select(model.user_id)).scalars().all())  # type: ignore[attr-defined]
    finally:
        session.close()


def _user(session_factory: Callable[[], Session], user_id: str) -> User:
    session = session_factory()
    try:
        return session.execute(select(User).where(User.user_id == user_id)).scalar_one()
    finally:
        session.close()


def test_a_merge_moves_keys_usage_and_aliases_and_retires_the_source(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_200_OK, response.text
    body = response.json()
    assert body["moved"]["api_keys"] == 2
    assert body["moved"]["usage_logs"] == 1
    assert body["moved"]["model_aliases"] == 1
    assert body["user"]["user_id"] == world.account

    for model in (APIKey, UsageLog, ModelAlias):
        assert LEGACY not in _owners(db_session_factory, model), model.__tablename__
    assert _owners(db_session_factory, APIKey).count(world.account) == 2

    # The target's counters count its own budget window, so the source's are not added; the rows carry them.
    target = _user(db_session_factory, world.account)
    assert (target.spend, target.current_requests, target.current_tokens) == (Decimal("1.50"), 2, 0)

    source = _user(db_session_factory, LEGACY)
    assert source.deleted_at is not None
    assert source.metadata_["merged_into"] == world.account

    listed = client.get(f"{API_ROOT}/users?limit=1000", headers=master_key_header).json()
    assert LEGACY not in {row["user_id"] for row in listed}


def test_a_sign_in_accounts_user_cannot_be_the_source(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    response = _merge(client, master_key_header, target=LEGACY, source=world.account)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_reservation_in_flight_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    session = db_session_factory()
    try:
        session.add(BudgetReservation(user_id=LEGACY, expires_at=datetime.now(UTC) + timedelta(hours=1)))
        session.commit()
    finally:
        session.close()

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_same_named_per_user_alias_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    session = db_session_factory()
    try:
        session.add(
            ModelAlias(
                name="fast",
                target="openai:gpt-4o",
                workspace_id=world.workspace_id,
                user_id=world.account,
                updated_at=datetime.now(UTC),
            )
        )
        session.commit()
    finally:
        session.close()

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert "fast" in response.json()["detail"]
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_user_cannot_be_merged_into_itself(
    client: TestClient, master_key_header: dict[str, str], world: _World
) -> None:
    response = _merge(client, master_key_header, target=LEGACY, source=LEGACY)

    assert response.status_code == status.HTTP_400_BAD_REQUEST, response.text


def test_an_unknown_source_is_not_found(client: TestClient, master_key_header: dict[str, str], world: _World) -> None:
    response = _merge(client, master_key_header, target=world.account, source="nobody-by-this-id")

    assert response.status_code == status.HTTP_404_NOT_FOUND, response.text


def _add(session_factory: Callable[[], Session], *rows: Any) -> None:
    session = session_factory()
    try:
        session.add_all(rows)
        session.commit()
    finally:
        session.close()


def test_a_merge_moves_the_end_users_a_service_key_bills(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    """A service key finds its end users by its own user, so they follow the key to the target."""
    _add(db_session_factory, User(user_id="end-1", parent_user_id=LEGACY, external_id="customer-1", blocked=True))

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_200_OK, response.text
    assert response.json()["moved"]["end_users"] == 1
    end_user = _user(db_session_factory, "end-1")
    assert end_user.parent_user_id == world.account
    assert end_user.blocked


def test_an_end_user_both_users_bill_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    _add(
        db_session_factory,
        User(user_id="end-legacy", parent_user_id=LEGACY, external_id="customer-1"),
        User(user_id="end-account", parent_user_id=world.account, external_id="customer-1"),
    )

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert "customer-1" in response.json()["detail"]
    assert _user(db_session_factory, "end-legacy").parent_user_id == LEGACY


def test_a_merge_moves_a_users_own_provider_endpoint(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    _add(
        db_session_factory,
        ProviderEndpoint(
            workspace_id=world.workspace_id,
            user_id=LEGACY,
            name="homelab",
            provider="openai",
            api_base="https://llm.example.com/v1",
        ),
    )

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_200_OK, response.text
    assert response.json()["moved"]["provider_endpoints"] == 1
    assert _owners(db_session_factory, ProviderEndpoint) == [world.account]


def _seed_every_reference(session: Session, workspace_id: uuid.UUID, user_id: str) -> uuid.UUID:
    """One row naming ``user_id`` in each table that references ``users``, beyond the world's; the MCP server's id."""
    now = datetime.now(UTC)
    workspace = session.get(Workspace, workspace_id)
    assert workspace is not None
    server = WorkspaceMcpServer(
        organization_id=workspace.organization_id, workspace_id=workspace_id, name="docs", url="https://mcp.example.com"
    )
    budget = Budget()
    session.add_all([server, budget])
    session.commit()
    session.refresh(server)
    session.refresh(budget)
    connection = {
        "client_id": "client",
        "client_auth_method": "none",
        "token_endpoint": "https://auth.example.com/token",
        "server_url": "https://mcp.example.com",
    }
    session.add_all(
        [
            BudgetReservation(user_id=user_id, status="settled", expires_at=now),
            BudgetResetLog(user_id=user_id, budget_id=budget.budget_id, previous_spend=Decimal("1")),
            FileObject(user_id=user_id, workspace_id=workspace_id, filename="a.txt", mime_type="text/plain", bytes=1),
            ProviderEndpoint(
                workspace_id=workspace_id, user_id=user_id, name="homelab", provider="openai", api_base="https://x"
            ),
            RoutingPolicy(
                name="mine", spec={"select": [{"default": "openai:gpt-4o"}]}, workspace_id=workspace_id, user_id=user_id
            ),
            SandboxContainer(
                id="cntr_merge",
                user_id=user_id,
                workspace_id=workspace_id,
                provider="e2b",
                provider_session_id="session",
                created_at=now,
                last_used_at=now,
                expires_at=now + timedelta(hours=1),
                hard_expires_at=now + timedelta(hours=1),
            ),
            AgentTelemetry(user_id=user_id, name="tool_call", source="claude_code", dedup_key="seed"),
            AgentTelemetryUserBarrier(user_id=user_id),
            SubagentDecision(
                id=uuid.uuid4(),
                workspace_id=workspace_id,
                user_id=user_id,
                harness="claude-code",
                agent_type="Explore",
                parent_model="claude-opus-5",
                baseline_model="claude-opus-5",
                baseline_source="parent",
                recommended_model="haiku",
            ),
            BatchRecord(id="batch_merge", provider="openai", user_id=user_id, model="gpt-4o"),
            VideoJobRecord(id="video_merge", provider="openai", model="sora", user_id=user_id),
            IdempotencyRecord(
                scope="chat",
                idempotency_key="merge",
                request_hash="h",
                claim_token=str(uuid.uuid4()),
                state="completed",
                user_id=user_id,
                locked_until=now,
                expires_at=now + timedelta(hours=1),
            ),
            WorkspaceMcpServerGrant(server_id=server.id, workspace_id=workspace_id, user_id=user_id, tools=[]),
            McpUserConnection(server_id=server.id, user_id=user_id, encrypted_access_token="t", **connection),
            McpOAuthFlow(
                state_hash="merge",
                server_id=server.id,
                user_id=user_id,
                encrypted_code_verifier="v",
                redirect_uri="https://gateway.example.com/callback",
                expires_at=now + timedelta(minutes=5),
                **connection,
            ),
            Trace(
                workspace_id=workspace_id,
                user_id=user_id,
                trace_id="trace-merge",
                session_source="otlp",
                started_at=now,
                last_activity_at=now,
            ),
            User(user_id="end-merge", parent_user_id=user_id, external_id="customer-merge"),
        ]
    )
    session.commit()
    return server.id


def _referencing_columns(session: Session) -> set[tuple[str, str]]:
    return {
        (str(table), str(column))
        for table, column in session.execute(
            text(
                "SELECT conrelid::regclass::text, a.attname FROM pg_constraint c "
                "JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
                "WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass"
            )
        )
    }


def test_every_table_that_references_a_user_is_moved(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, world: _World
) -> None:
    """Every column with a foreign key to ``users`` holds a row naming the source, and none still does after.

    A table that gains such a key and no listener moves fails here: the seed
    below misses it, or the merge leaves its row on the retired user.
    """
    _seed_every_reference(db_session, world.workspace_id, LEGACY)
    columns = _referencing_columns(db_session)

    def naming(user_id: str) -> dict[tuple[str, str], int]:
        return {
            (table, column): int(
                db_session.execute(
                    text(f"SELECT count(*) FROM {table} WHERE {column} = :u"), {"u": user_id}
                ).scalar_one()
            )
            for table, column in columns
        }

    before = naming(LEGACY)
    assert [ref for ref, count in before.items() if count == 0] == [], "seed a row for every reference"
    preview = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True).json()
    # A barrier is dropped with the telemetry it guards rather than moved, so the merge reports no count for it.
    assert set(preview["moved"]) >= {table for table, _ in columns} - {"users", "agent_telemetry_user_barriers"} | {
        "end_users"
    }

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)
    assert response.status_code == status.HTTP_200_OK, response.text

    db_session.expire_all()
    # The source's own row in ``users`` is the one row left naming it.
    assert {ref: count for ref, count in naming(LEGACY).items() if count} == {}
    after = naming(world.account)
    for ref, count in before.items():
        if ref[0] != "agent_telemetry_user_barriers":
            assert after[ref] >= count, ref
    assert response.json()["moved"] == {**preview["moved"], "agent_telemetry": preview["moved"]["agent_telemetry"]}


def test_moved_usage_marks_its_hours_for_the_rollups_to_rebuild(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, world: _World
) -> None:
    """``usage_rollups.user_id`` has no foreign key: the trigger on ``usage_logs`` marks the hour, and it rebuilds."""
    db_session.execute(text("DELETE FROM usage_rollup_dirty_hours"))
    db_session.commit()

    assert _merge(client, master_key_header, target=world.account, source=LEGACY).status_code == status.HTTP_200_OK

    marked = db_session.execute(text("SELECT count(*) FROM usage_rollup_dirty_hours")).scalar_one()
    assert marked >= 1


def test_a_dropped_mcp_connection_is_revoked_once_the_merge_commits(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session: Session,
    world: _World,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    server_id = _seed_every_reference(db_session, world.workspace_id, LEGACY)
    db_session.execute(text("UPDATE mcp_user_connections SET revocation_endpoint = 'https://auth.example.com/revoke'"))
    db_session.add(
        McpUserConnection(
            server_id=server_id,
            user_id=world.account,
            encrypted_access_token="theirs",
            client_id="client",
            client_auth_method="none",
            token_endpoint="https://auth.example.com/token",
            server_url="https://mcp.example.com",
        )
    )
    db_session.commit()
    collected: list[tuple[set[uuid.UUID], str]] = []
    revoked: list[list[str]] = []

    async def collect(_connections: Any, _servers: Any, *, server_ids: set[uuid.UUID], user_id: str) -> Any:
        # Which tokens a revocation sends is the deletion path's to decide; this checks what the merge hands it.
        collected.append((set(server_ids), user_id))
        return ["the source's token"], 0, 1

    monkeypatch.setattr(user_merge_listeners, "collect_revocations", collect)
    monkeypatch.setattr(
        user_merge_listeners, "revoke_in_background", lambda revocations, *, unread=0: revoked.append(list(revocations))
    )

    preview = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)
    assert preview.json()["moved"]["mcp_user_connections"] == 0
    assert revoked == []

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_200_OK, response.text
    assert collected == [({server_id}, LEGACY)]
    assert revoked == [["the source's token"]]
    db_session.expire_all()
    owners = db_session.execute(text("SELECT user_id, encrypted_access_token FROM mcp_user_connections")).all()
    assert [tuple(row) for row in owners] == [(world.account, "theirs")]


def test_a_preview_says_what_moves_and_changes_nothing(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    preview = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)

    assert preview.status_code == status.HTTP_200_OK, preview.text
    body = preview.json()
    assert body["preview"] is True
    assert (body["moved"]["api_keys"], body["moved"]["usage_logs"], body["moved"]["model_aliases"]) == (2, 1, 1)
    assert "spend" not in body
    assert body["user"]["spend"] == 1.5
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2
    assert _user(db_session_factory, LEGACY).deleted_at is None

    merged = _merge(client, master_key_header, target=world.account, source=LEGACY).json()
    assert merged["preview"] is False
    assert merged["moved"] == body["moved"]


def test_a_merge_moves_agent_telemetry(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    _add(
        db_session_factory,
        AgentTelemetry(
            user_id=LEGACY,
            name="tool_call",
            source="claude_code",
            dedup_key="merge-test",
            timestamp=datetime.now(UTC),
        ),
    )

    preview = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True).json()
    assert preview["moved"]["agent_telemetry"] == 1
    assert _owners(db_session_factory, AgentTelemetry) == [LEGACY]

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)
    assert response.status_code == status.HTTP_200_OK, response.text
    assert response.json()["moved"]["agent_telemetry"] == 1
    assert _owners(db_session_factory, AgentTelemetry) == [world.account]


def test_the_merge_is_recorded_on_the_retired_user(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    assert _merge(client, master_key_header, target=world.account, source=LEGACY).status_code == status.HTTP_200_OK

    metadata = _user(db_session_factory, LEGACY).metadata_
    assert metadata["merged_into"] == world.account
    assert metadata["merged_at"]
    # The master key acts as the bootstrap operator, whose identity is recorded.
    assert uuid.UUID(metadata["merged_by"])


def _usage_row(workspace_id: uuid.UUID, user_id: str, *, age: timedelta) -> UsageLog:
    return UsageLog(
        id=str(uuid.uuid4()),
        workspace_id=workspace_id,
        user_id=user_id,
        model="m",
        provider="p",
        endpoint="/v1/chat/completions",
        source="gateway",
        status="success",
        timestamp=datetime.now(UTC) - age,
    )


def test_running_the_merge_again_sweeps_what_reached_the_retired_user_since(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    assert _merge(client, master_key_header, target=world.account, source=LEGACY).status_code == status.HTTP_200_OK
    retired = _user(db_session_factory, LEGACY).metadata_
    # The log writer's batch lands a row on the source after it was retired.
    _add(db_session_factory, _usage_row(world.workspace_id, LEGACY, age=timedelta(hours=1)))

    again = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert again.status_code == status.HTTP_200_OK, again.text
    assert again.json()["resumed"] is True
    assert again.json()["moved"]["usage_logs"] == 1
    assert LEGACY not in _owners(db_session_factory, UsageLog)
    source = _user(db_session_factory, LEGACY)
    # Left retired as it was: the first merge's record stands.
    assert source.deleted_at is not None
    assert source.metadata_ == retired
    target = _user(db_session_factory, world.account)
    assert (target.spend, target.current_requests) == (Decimal("1.50"), 2)


def test_a_retired_user_cannot_be_merged_into_anyone_else(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    assert _merge(client, master_key_header, target=world.account, source=LEGACY).status_code == status.HTTP_200_OK
    _add(db_session_factory, User(user_id="someone-else", alias="Someone"))

    again = _merge(client, master_key_header, target="someone-else", source=LEGACY, preview=True)

    assert again.status_code == status.HTTP_409_CONFLICT, again.text
    assert _user(db_session_factory, LEGACY).metadata_["merged_into"] == world.account


def test_a_source_still_sending_requests_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    _add(db_session_factory, _usage_row(world.workspace_id, LEGACY, age=timedelta(minutes=1)))

    response = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert "last 5 minutes" in response.json()["detail"]
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_routing_condition_naming_the_source_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    """A ``when.user_id`` condition stops matching once the requests bill someone else, so it is changed first."""
    spec = {
        "select": [
            {"when": {"user_id": ["someone", LEGACY]}, "target": "openai:gpt-4o-mini"},
            {"default": "openai:gpt-4o"},
        ]
    }
    _add(db_session_factory, RoutingPolicy(name="pat-cheap", spec=spec, workspace_id=world.workspace_id))

    response = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert "pat-cheap" in response.json()["detail"]
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_same_named_per_user_routing_policy_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    spec = {"select": [{"default": "openai:gpt-4o"}]}
    _add(
        db_session_factory,
        RoutingPolicy(name="mine", spec=spec, workspace_id=world.workspace_id, user_id=LEGACY),
        RoutingPolicy(name="mine", spec=spec, workspace_id=world.workspace_id, user_id=world.account),
    )

    preview = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)

    # A preview is refused the same way, before anything is confirmed.
    assert preview.status_code == status.HTTP_409_CONFLICT, preview.text
    assert "mine" in preview.json()["detail"]
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_source_another_organization_also_uses_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    session = db_session_factory()
    try:
        other = Organization(name="Other", slug="other")
        session.add(other)
        session.commit()
        session.refresh(other)
        workspace = Workspace(name="Other one", organization_id=other.id)
        session.add(workspace)
        session.commit()
        session.refresh(workspace)
        session.add(
            APIKey(
                id=str(uuid.uuid4()),
                workspace_id=workspace.id,
                key_hash="hash-other",
                key_prefix="gw-other",
                user_id=LEGACY,
            )
        )
        session.commit()
    finally:
        session.close()

    response = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert "another organization" in response.json()["detail"]
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 3


def test_the_shared_default_user_cannot_be_the_source(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    session = db_session_factory()
    try:
        if session.get(User, "default") is None:
            session.add(User(user_id="default", alias="Default"))
            session.commit()
    finally:
        session.close()

    response = _merge(client, master_key_header, target=world.account, source="default", preview=True)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert _user(db_session_factory, "default").deleted_at is None


def test_rows_in_another_organizations_workspace_refuse_the_merge(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, world: _World
) -> None:
    """A row the other organization holds under the source refuses the merge, though no key or usage puts it there.

    Each table a merge moves is checked, not only those that put a user in an
    organization's reach, so none of the other organization's rows moves.
    """
    other = Organization(name="Other", slug="other")
    db_session.add(other)
    db_session.commit()
    db_session.refresh(other)
    elsewhere = Workspace(name="Other one", organization_id=other.id)
    db_session.add(elsewhere)
    db_session.commit()
    db_session.refresh(elsewhere)
    _seed_every_reference(db_session, elsewhere.id, LEGACY)

    for preview in (True, False):
        response = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=preview)
        assert response.status_code == status.HTTP_409_CONFLICT, response.text
        detail = response.json()["detail"]
        assert "another organization" in detail
        for table in ("routing_policies", "provider_endpoints", "traces", "file_objects", "mcp_user_connections"):
            assert table in detail, table

    moved = db_session.execute(
        text(
            "SELECT user_id FROM routing_policies WHERE workspace_id = :w UNION ALL "
            "SELECT user_id FROM provider_endpoints WHERE workspace_id = :w UNION ALL "
            "SELECT user_id FROM traces WHERE workspace_id = :w UNION ALL "
            "SELECT user_id FROM file_objects WHERE workspace_id = :w"
        ),
        {"w": elsewhere.id},
    ).scalars()
    assert set(moved) == {LEGACY}


def test_an_end_user_another_organization_bills_refuses_the_merge(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session: Session,
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    """The source's end user carries usage in another organization, so moving it onto the target is refused."""
    other = Organization(name="Other", slug="other")
    db_session.add(other)
    db_session.commit()
    db_session.refresh(other)
    elsewhere = Workspace(name="Other one", organization_id=other.id)
    db_session.add(elsewhere)
    db_session.commit()
    db_session.refresh(elsewhere)
    _add(db_session_factory, User(user_id="end-elsewhere", parent_user_id=LEGACY, external_id="customer-elsewhere"))
    _add(
        db_session_factory,
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=elsewhere.id,
            user_id="end-elsewhere",
            model="m",
            provider="p",
            endpoint="/v1/chat/completions",
            source="gateway",
            status="success",
            timestamp=datetime.now(UTC) - timedelta(hours=1),
        ),
    )

    response = _merge(client, master_key_header, target=world.account, source=LEGACY)

    assert response.status_code == status.HTTP_409_CONFLICT, response.text
    assert "another organization" in response.json()["detail"]
    assert _user(db_session_factory, "end-elsewhere").parent_user_id == LEGACY


def test_an_end_user_or_a_record_no_account_owns_cannot_be_the_target(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    _add(
        db_session_factory,
        User(user_id="plain-record", alias="Plain"),
        User(user_id="end-target", parent_user_id=LEGACY, external_id="customer-target"),
    )

    for target in ("plain-record", "end-target"):
        response = _merge(client, master_key_header, target=target, source=LEGACY, preview=True)
        assert response.status_code == status.HTTP_409_CONFLICT, (target, response.text)
        assert "sign-in account" in response.json()["detail"]
    assert _owners(db_session_factory, APIKey).count(LEGACY) == 2


def test_a_resumed_merge_sweeps_rows_written_moments_ago(
    client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
    world: _World,
) -> None:
    """The quiet period guards a first merge; rows reaching a retired source are what running it again is for."""
    assert _merge(client, master_key_header, target=world.account, source=LEGACY).status_code == status.HTTP_200_OK
    _add(db_session_factory, _usage_row(world.workspace_id, LEGACY, age=timedelta(seconds=5)))

    preview = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)
    assert preview.status_code == status.HTTP_200_OK, preview.text
    assert (preview.json()["resumed"], preview.json()["moved"]["usage_logs"]) == (True, 1)

    swept = _merge(client, master_key_header, target=world.account, source=LEGACY)
    assert swept.status_code == status.HTTP_200_OK, swept.text
    assert LEGACY not in _owners(db_session_factory, UsageLog)
