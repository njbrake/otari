"""``/api/v1/organizations/me/keys`` for an organization owner or admin: every key in the organization, never another's.

Alpha has two workspaces, an owner and an admin in neither, two members of the
first and a newcomer in none. Beta is a second organization with a key of its
own. Each widened action is checked three ways: an owner or admin may, a member
of the same organization may not, and nobody reaches into Beta.
"""

import uuid
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session

from gateway.auth.models import hash_key
from gateway.core.config import API_ROOT
from gateway.models.api_keys import APIKey
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User, Workspace, WorkspaceMember
from gateway.models.users import User as BillingUser
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

from .conftest import build_test_client, declared_test_providers, shared_test_config

_KEYS = f"{API_ROOT}/organizations/me/keys"
_TOOL_NAMES = f"{API_ROOT}/organizations/me/search-tools"


@dataclass
class _World:
    alpha: uuid.UUID = uuid.UUID(int=0)
    workspaces: dict[str, uuid.UUID] = field(default_factory=dict)
    users: dict[str, uuid.UUID] = field(default_factory=dict)
    sessions: dict[str, str] = field(default_factory=dict)
    keys: dict[str, str] = field(default_factory=dict)


@pytest.fixture
def admin_client(postgres_url: str, clean_database: None) -> Generator[TestClient]:
    """A client whose deployment declares one search tool, so the names read has something to list.

    Built fresh rather than copied from ``test_config``: a copy keeps the
    config-file tool baseline an earlier test on the worker may have captured.
    """
    config = shared_test_config(postgres_url, declared_test_providers()).model_copy(
        update={"search_tools": {"exa-search": {"provider": "exa", "api_key": "k"}}}
    )
    yield from build_test_client(config)


def _identity(
    session: Session,
    *,
    email: str,
    organization_id: uuid.UUID,
    role: str = "member",
    workspace_ids: tuple[uuid.UUID, ...] = (),
) -> tuple[uuid.UUID, str]:
    """An identity with a live dashboard session and the billing row its keys hang off; its id and cookie."""
    user = User(email=email, full_name=email.split("@")[0].title(), active_organization_id=organization_id)
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(OrganizationMember(organization_id=organization_id, user_id=user.id, role=role, status="active"))
    for workspace_id in workspace_ids:
        session.add(WorkspaceMember(workspace_id=workspace_id, user_id=user.id, role="member", status="active"))
    token = f"otari-sess-{email}"
    session.add(
        DashboardSession(
            token_hash=hash_session_token(token),
            user_id=user.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=12),
        )
    )
    session.add(BillingUser(user_id=str(user.id), alias=email))
    session.commit()
    return user.id, token


def _key(session: Session, workspace_id: uuid.UUID, owner: uuid.UUID) -> str:
    key_id = str(uuid.uuid4())
    session.add(
        APIKey(
            id=key_id,
            workspace_id=workspace_id,
            key_hash=hash_key(key_id),
            key_name=f"key-{key_id[:8]}",
            user_id=str(owner),
        )
    )
    session.commit()
    return key_id


@pytest.fixture
def world(
    admin_client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]
) -> _World:
    assert admin_client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK
    session = db_session_factory()
    try:
        alpha = Organization(name="Alpha", slug="alpha")
        beta = Organization(name="Beta", slug="beta")
        session.add_all([alpha, beta])
        session.commit()
        # Created first, so it is the default workspace the omitted-workspace cases resolve.
        alpha_one = Workspace(name="Alpha one", organization_id=alpha.id)
        session.add(alpha_one)
        session.commit()
        alpha_two = Workspace(name="Alpha two", organization_id=alpha.id)
        beta_one = Workspace(name="Beta one", organization_id=beta.id)
        session.add_all([alpha_two, beta_one])
        session.commit()

        built = _World(alpha=alpha.id)
        built.workspaces = {"alpha_one": alpha_one.id, "alpha_two": alpha_two.id, "beta_one": beta_one.id}
        people = {
            "owner": _identity(session, email="owner@alpha.test", organization_id=alpha.id, role="owner"),
            "admin": _identity(session, email="admin@alpha.test", organization_id=alpha.id, role="admin"),
            "member": _identity(
                session, email="member@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
            ),
            "colleague": _identity(
                session, email="colleague@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
            ),
            "newcomer": _identity(session, email="new@alpha.test", organization_id=alpha.id),
            "beta_owner": _identity(session, email="owner@beta.test", organization_id=beta.id, role="owner"),
        }
        built.users = {name: user_id for name, (user_id, _) in people.items()}
        built.sessions = {name: token for name, (_, token) in people.items()}
        built.keys = {
            "member": _key(session, alpha_one.id, built.users["member"]),
            "colleague": _key(session, alpha_one.id, built.users["colleague"]),
            "beta": _key(session, beta_one.id, built.users["beta_owner"]),
        }
        return built
    finally:
        session.close()


def _call(
    client: TestClient,
    world: _World,
    who: str,
    method: str,
    path: str,
    *,
    json: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions[who])
    try:
        response = client.request(method, path, json=json, params=params)
        is_json = response.headers.get("content-type", "").startswith("application/json")
        return response.status_code, response.json() if is_json and response.content else None
    finally:
        client.cookies.clear()


def _listed(client: TestClient, world: _World, who: str, workspace: str | None = None) -> set[str]:
    params = {"workspace_id": str(world.workspaces[workspace])} if workspace is not None else None
    code, body = _call(client, world, who, "GET", _KEYS, params=params)
    assert code == status.HTTP_200_OK, body
    return {row["id"] for row in body}


# =============================================================================
# Reading
# =============================================================================


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_an_owner_or_admin_lists_every_key_in_the_organization(
    admin_client: TestClient, world: _World, who: str
) -> None:
    listed = _listed(admin_client, world, who)
    assert {world.keys["member"], world.keys["colleague"]} <= listed
    assert world.keys["beta"] not in listed


def test_a_member_still_lists_only_their_own(admin_client: TestClient, world: _World) -> None:
    listed = _listed(admin_client, world, "member")
    assert world.keys["member"] in listed
    assert world.keys["colleague"] not in listed
    assert world.keys["beta"] not in listed


def test_an_admin_reads_any_keys_routing_in_the_organization_and_a_member_only_their_own(
    admin_client: TestClient, world: _World
) -> None:
    asked = {"api_key_id": [world.keys["member"], world.keys["colleague"], world.keys["beta"]]}
    code, body = _call(admin_client, world, "admin", "GET", f"{_KEYS}/routing", params=asked)
    assert code == status.HTTP_200_OK, body
    assert [key["api_key_id"] for key in body["keys"]] == [world.keys["member"], world.keys["colleague"]]

    code, body = _call(admin_client, world, "member", "GET", f"{_KEYS}/routing", params=asked)
    assert code == status.HTTP_200_OK, body
    assert [key["api_key_id"] for key in body["keys"]] == [world.keys["member"]]


def test_a_lowered_role_takes_the_organizations_keys_away_at_once(
    admin_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    assert world.keys["colleague"] in _listed(admin_client, world, "admin")
    session = db_session_factory()
    try:
        session.execute(
            update(OrganizationMember)
            .where(OrganizationMember.user_id == world.users["admin"])  # type: ignore[arg-type]
            .values(role="member")
        )
        session.commit()
    finally:
        session.close()
    assert world.keys["colleague"] not in _listed(admin_client, world, "admin")
    code, _ = _call(admin_client, world, "admin", "DELETE", f"{_KEYS}/{world.keys['colleague']}")
    assert code == status.HTTP_404_NOT_FOUND


# =============================================================================
# Managing an existing key
# =============================================================================


@pytest.mark.parametrize("owner", ["member", "owner"])
def test_an_admin_updates_rotates_and_deletes_a_members_key(
    admin_client: TestClient, world: _World, db_session_factory: Callable[[], Session], owner: str
) -> None:
    # The organization's owner is a member like any other here: an admin manages
    # their ordinary keys too, by decision rather than by omission.
    session = db_session_factory()
    try:
        key = _key(session, world.workspaces["alpha_one"], world.users[owner])
    finally:
        session.close()
    code, body = _call(admin_client, world, "admin", "PATCH", f"{_KEYS}/{key}", json={"key_name": "renamed"})
    assert code == status.HTTP_200_OK, body
    assert (body["key_name"], body["user_id"]) == ("renamed", str(world.users[owner]))

    code, body = _call(admin_client, world, "admin", "POST", f"{_KEYS}/{key}/rotate")
    assert code == status.HTTP_200_OK, body
    assert body["key"]

    code, _ = _call(admin_client, world, "admin", "DELETE", f"{_KEYS}/{key}")
    assert code == status.HTTP_204_NO_CONTENT
    assert key not in _listed(admin_client, world, owner)


@pytest.mark.parametrize(("method", "suffix"), [("PATCH", ""), ("POST", "/rotate"), ("DELETE", "")])
def test_a_member_cannot_touch_a_colleagues_key(
    admin_client: TestClient, world: _World, method: str, suffix: str
) -> None:
    body = {"key_name": "taken"} if method == "PATCH" else None
    code, _ = _call(admin_client, world, "member", method, f"{_KEYS}/{world.keys['colleague']}{suffix}", json=body)
    assert code == status.HTTP_404_NOT_FOUND


@pytest.mark.parametrize(("method", "suffix"), [("PATCH", ""), ("POST", "/rotate"), ("DELETE", "")])
def test_an_admin_cannot_touch_another_organizations_key(
    admin_client: TestClient, world: _World, method: str, suffix: str
) -> None:
    body = {"key_name": "taken"} if method == "PATCH" else None
    code, _ = _call(admin_client, world, "admin", method, f"{_KEYS}/{world.keys['beta']}{suffix}", json=body)
    assert code == status.HTTP_404_NOT_FOUND


def test_an_admin_cannot_widen_a_key_past_its_owners_model_access(
    admin_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    session = db_session_factory()
    try:
        session.execute(
            update(BillingUser)
            .where(BillingUser.user_id == str(world.users["member"]))
            .values(allowed_models=["openai:gpt-4o"])
        )
        session.commit()
    finally:
        session.close()

    code, body = _call(
        admin_client,
        world,
        "admin",
        "PATCH",
        f"{_KEYS}/{world.keys['member']}",
        json={"allowed_models": ["openai:gpt-4o", "anthropic:*"]},
    )
    assert code == status.HTTP_400_BAD_REQUEST, body


def test_nobody_on_this_surface_can_exempt_a_key_from_budget(admin_client: TestClient, world: _World) -> None:
    code, body = _call(
        admin_client, world, "admin", "PATCH", f"{_KEYS}/{world.keys['member']}", json={"exclude_from_budget": True}
    )
    assert code == status.HTTP_200_OK, body
    assert body["exclude_from_budget"] is False


@pytest.mark.parametrize(
    ("owner", "fields"),
    [
        # Owned by a member, so only the exemption keeps it out.
        pytest.param("colleague", {"exclude_from_budget": True}, id="exempt"),
        pytest.param("colleague", {"is_service_key": True}, id="service"),
        pytest.param(None, {"allowed_models": ["openai:gpt-4o"]}, id="ownerless"),
    ],
)
def test_an_admin_cannot_reach_a_key_only_the_operator_may_hand_out(
    admin_client: TestClient,
    world: _World,
    db_session_factory: Callable[[], Session],
    owner: str | None,
    fields: dict[str, Any],
) -> None:
    session = db_session_factory()
    try:
        key = str(uuid.uuid4())
        session.add(
            APIKey(
                id=key,
                workspace_id=world.workspaces["alpha_one"],
                key_hash=hash_key(key),
                key_name="op",
                user_id=str(world.users[owner]) if owner else None,
                **fields,
            )
        )
        session.commit()
    finally:
        session.close()

    assert key not in _listed(admin_client, world, "admin")
    code, body = _call(admin_client, world, "admin", "GET", f"{_KEYS}/routing", params={"api_key_id": [key]})
    assert code == status.HTTP_200_OK, body
    assert body["keys"] == []
    for method, suffix, json in [
        ("PATCH", "", {"allowed_models": None}),
        ("POST", "/rotate", None),
        ("DELETE", "", None),
    ]:
        code, _ = _call(admin_client, world, "admin", method, f"{_KEYS}/{key}{suffix}", json=json)
        assert code == status.HTTP_404_NOT_FOUND, (method, suffix)
    # Its owner still has it, as a member always had an operator-minted key of theirs.
    if owner is not None:
        assert key in _listed(admin_client, world, owner)


# =============================================================================
# Creating a key for a member
# =============================================================================


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_an_owner_or_admin_creates_a_key_for_a_member(admin_client: TestClient, world: _World, who: str) -> None:
    code, body = _call(
        admin_client,
        world,
        who,
        "POST",
        _KEYS,
        json={
            "key_name": "for-member",
            "user_id": str(world.users["member"]),
            "workspace_id": str(world.workspaces["alpha_one"]),
            "exclude_from_budget": True,
        },
    )
    assert code == status.HTTP_200_OK, body
    assert body["user_id"] == str(world.users["member"])
    assert body["id"] in _listed(admin_client, world, who, "alpha_one")
    assert body["exclude_from_budget"] is False
    assert body["id"] in _listed(admin_client, world, "member")
    assert body["id"] not in _listed(admin_client, world, "colleague")


def test_an_omitted_workspace_resolves_against_the_member(admin_client: TestClient, world: _World) -> None:
    code, body = _call(admin_client, world, "admin", "POST", _KEYS, json={"user_id": str(world.users["member"])})
    assert code == status.HTTP_200_OK, body
    assert body["id"] in _listed(admin_client, world, "admin", "alpha_one")

    # The newcomer is in no workspace, so the default one is not theirs either.
    code, body = _call(admin_client, world, "admin", "POST", _KEYS, json={"user_id": str(world.users["newcomer"])})
    assert code == status.HTTP_409_CONFLICT, body
    assert "That member" in body["detail"]


def test_a_key_lands_only_in_a_workspace_its_owner_may_see(admin_client: TestClient, world: _World) -> None:
    code, _ = _call(
        admin_client,
        world,
        "admin",
        "POST",
        _KEYS,
        json={"user_id": str(world.users["member"]), "workspace_id": str(world.workspaces["alpha_two"])},
    )
    assert code == status.HTTP_404_NOT_FOUND


@pytest.mark.parametrize("target", ["beta_owner", "unknown"])
def test_an_admin_cannot_create_a_key_for_someone_outside_the_organization(
    admin_client: TestClient, world: _World, target: str
) -> None:
    user_id = str(world.users[target]) if target in world.users else str(uuid.uuid4())
    code, body = _call(admin_client, world, "admin", "POST", _KEYS, json={"user_id": user_id})
    assert code == status.HTTP_404_NOT_FOUND
    assert body["detail"] == "No such member in this organization."


def test_a_member_cannot_create_a_key_for_someone_else(admin_client: TestClient, world: _World) -> None:
    code, _ = _call(admin_client, world, "member", "POST", _KEYS, json={"user_id": str(world.users["colleague"])})
    assert code == status.HTTP_403_FORBIDDEN
    assert _listed(admin_client, world, "colleague") == {world.keys["colleague"]}


def test_a_revoked_member_gets_no_key_from_an_admin_either(
    admin_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    session = db_session_factory()
    try:
        session.execute(
            update(BillingUser)
            .where(BillingUser.user_id == str(world.users["member"]))
            .values(deleted_at=datetime.now(UTC))
        )
        session.commit()
    finally:
        session.close()
    code, body = _call(admin_client, world, "admin", "POST", _KEYS, json={"user_id": str(world.users["member"])})
    assert code == status.HTTP_409_CONFLICT, body


# =============================================================================
# Search tool names
# =============================================================================


@pytest.mark.parametrize("who", ["owner", "admin"])
def test_an_owner_or_admin_reads_the_search_tool_names(admin_client: TestClient, world: _World, who: str) -> None:
    code, body = _call(admin_client, world, who, "GET", _TOOL_NAMES)
    assert code == status.HTTP_200_OK, body
    assert body == {"names": ["exa-search"]}

    code, body = _call(admin_client, world, who, "GET", _TOOL_NAMES, params={"kind": "fetch"})
    assert code == status.HTTP_200_OK, body
    assert "builtin_fetch" in body["names"]


def test_a_member_cannot_read_the_search_tool_names(admin_client: TestClient, world: _World) -> None:
    code, _ = _call(admin_client, world, "member", "GET", _TOOL_NAMES)
    assert code == status.HTTP_403_FORBIDDEN


def test_the_search_tool_names_need_a_signed_in_caller(admin_client: TestClient, world: _World) -> None:
    assert admin_client.get(_TOOL_NAMES).status_code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)
