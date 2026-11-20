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
from gateway.models.budgets import BudgetReservation
from gateway.models.providers import ModelAlias, ProviderEndpoint
from gateway.models.routing import RoutingPolicy
from gateway.models.tenancy import OrganizationMember, Workspace
from gateway.models.tenancy import User as Identity
from gateway.models.usage import AgentTelemetry, UsageLog
from gateway.models.users import User
from gateway.services.tenancy.provisioning_service import DEFAULT_WORKSPACE_NAME

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
        identity = Identity(
            email="pat@example.com", full_name="Pat", active_organization_id=workspace.organization_id
        )
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
                User(user_id=LEGACY, alias="Pat (old id)", spend=Decimal("2.25"), current_requests=3, current_tokens=40),
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
                    timestamp=datetime.now(UTC),
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

    target = _user(db_session_factory, world.account)
    assert target.spend == Decimal("3.75")
    assert target.current_requests == 5
    assert target.current_tokens == 40

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


def test_every_table_that_references_a_user_is_moved(
    client: TestClient, master_key_header: dict[str, str], db_session: Session, world: _World
) -> None:
    """A table that gains a foreign key to ``users`` is named by a merge, or this fails.

    A merge names every table it moves rows in, none moved included, so a table
    missing from its answer is one whose rows a merge would leave on a retired user.
    """
    referencing = {
        str(table)
        for (table,) in db_session.execute(
            text(
                "SELECT conrelid::regclass::text FROM pg_constraint c "
                "WHERE c.contype = 'f' AND c.confrelid = 'users'::regclass"
            )
        )
    }
    response = _merge(client, master_key_header, target=world.account, source=LEGACY, preview=True)
    assert response.status_code == status.HTTP_200_OK, response.text
    moved = set(response.json()["moved"])
    # End users reference ``users`` from ``users`` itself; the merge names them apart.
    assert referencing - {"users"} <= moved, referencing - moved
    assert "end_users" in moved


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
    assert (body["spend"], body["tokens"], body["requests"]) == (2.25, 40, 3)
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


def test_a_retired_user_cannot_be_merged_again(
    client: TestClient, master_key_header: dict[str, str], world: _World
) -> None:
    assert _merge(client, master_key_header, target=world.account, source=LEGACY).status_code == status.HTTP_200_OK

    again = _merge(client, master_key_header, target=world.account, source=LEGACY)
    assert again.status_code == status.HTTP_404_NOT_FOUND, again.text


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
