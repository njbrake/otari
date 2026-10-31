"""Routing policies of a member's own on ``/api/v1/organizations/me/routing-policies``.

A member may write a policy that applies only to their own requests, named by
their identity, never by billing id; an owner or admin may write anyone's in the
organization. A workspace's managers decide whether members may create one
(``members_create_policies``, on by default), and turning it off leaves the ones
members already have theirs to edit and delete. "Make my own version" copies a
shared policy into the caller's own, and an owner or admin can turn a workspace's
alias into a policy of the same name in one step.

Each widened action is checked three ways: who may, who may not in the same
organization, and that nobody reaches another organization.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy import update
from sqlalchemy.orm import Session
from sqlmodel import col

from gateway.core.config import API_ROOT, GatewayConfig
from gateway.models.provider_keys import OrgProviderKey
from gateway.models.routing import RoutingPolicy
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User, Workspace, WorkspaceMember
from gateway.models.users import User as BillingUser
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token
from gateway.services.secret_box import encrypt_secret, generate_secret_key

from .conftest import shared_test_config


@pytest.fixture(scope="module")
def test_config(postgres_url: str) -> GatewayConfig:
    """The shared configuration declaring no provider, so a bare selector reaches the organization's key."""
    return shared_test_config(postgres_url, {})


_POLICIES = f"{API_ROOT}/organizations/me/routing-policies"
_ALIASES = f"{API_ROOT}/organizations/me/aliases"
_TARGET = "openai:gpt-4o-mini"
_BACKUP = "openai:gpt-4o"


@pytest.fixture(autouse=True)
def _secret_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A real key, so the organization's stored provider key decrypts and its targets are reachable."""
    monkeypatch.setenv("OTARI_SECRET_KEY", generate_secret_key())


@dataclass
class _World:
    workspaces: dict[str, uuid.UUID] = field(default_factory=dict)
    users: dict[str, uuid.UUID] = field(default_factory=dict)
    sessions: dict[str, str] = field(default_factory=dict)


def _identity(
    session: Session,
    *,
    email: str,
    organization_id: uuid.UUID,
    role: str = "member",
    workspace_ids: tuple[uuid.UUID, ...] = (),
) -> tuple[uuid.UUID, str]:
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
    session.commit()
    return user.id, token


@pytest.fixture
def world(client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]) -> _World:
    assert client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK
    session = db_session_factory()
    try:
        alpha = Organization(name="Alpha", slug="alpha")
        beta = Organization(name="Beta", slug="beta")
        session.add_all([alpha, beta])
        session.commit()
        alpha_one = Workspace(name="Alpha one", organization_id=alpha.id)
        alpha_two = Workspace(name="Alpha two", organization_id=alpha.id)
        beta_one = Workspace(name="Beta one", organization_id=beta.id)
        session.add_all([alpha_one, alpha_two, beta_one])
        session.commit()
        for organization_id in (alpha.id, beta.id):
            session.add(
                OrgProviderKey(
                    organization_id=organization_id,
                    provider="openai",
                    name="openai-primary",
                    encrypted_api_key=encrypt_secret("sk-test-value"),
                    last4="1234",
                    is_org_default=True,
                )
            )
        session.commit()

        built = _World(workspaces={"alpha_one": alpha_one.id, "alpha_two": alpha_two.id, "beta_one": beta_one.id})
        people = {
            "admin": _identity(session, email="admin@alpha.test", organization_id=alpha.id, role="admin"),
            "member": _identity(
                session, email="member@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
            ),
            "colleague": _identity(
                session, email="colleague@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
            ),
            "beta_owner": _identity(
                session, email="owner@beta.test", organization_id=beta.id, role="owner", workspace_ids=(beta_one.id,)
            ),
        }
        built.users = {name: user_id for name, (user_id, _) in people.items()}
        built.sessions = {name: token for name, (_, token) in people.items()}
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


def _policy(
    world: _World, name: str, *, member: str | None = None, workspace: str = "alpha_one", **extra: Any
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": name,
        "spec": {"select": [{"default": _TARGET}], "on_failure": [_BACKUP]},
        "workspace_id": str(world.workspaces[workspace]),
        **extra,
    }
    if member is not None:
        body["member_id"] = str(world.users[member])
    return body


def _listed(client: TestClient, world: _World, who: str) -> set[tuple[str, str | None]]:
    code, body = _call(client, world, who, "GET", _POLICIES)
    assert code == status.HTTP_200_OK, body
    return {(row["name"], row["user_id"]) for row in body if row["source"] == "stored"}


def _set_members_create(client: TestClient, world: _World, value: bool) -> None:
    code, body = _call(
        client,
        world,
        "admin",
        "PATCH",
        f"{API_ROOT}/workspaces/{world.workspaces['alpha_one']}/visibility",
        json={"members_create_policies": value},
    )
    assert code == status.HTTP_200_OK, body
    assert body["members_create_policies"] is value


# =============================================================================
# A member's own
# =============================================================================


def test_a_member_writes_a_policy_of_their_own(client: TestClient, world: _World) -> None:
    code, body = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "mine", member="member"))
    assert code == status.HTTP_200_OK, body
    assert body["user_id"] == str(world.users["member"])

    own = ("mine", str(world.users["member"]))
    assert own in _listed(client, world, "member")
    assert own in _listed(client, world, "admin")
    assert own not in _listed(client, world, "colleague")


def test_a_member_still_cannot_write_a_workspace_wide_policy(client: TestClient, world: _World) -> None:
    code, _ = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "everyone"))
    assert code == status.HTTP_403_FORBIDDEN


def test_a_member_cannot_write_or_delete_a_colleagues_policy(client: TestClient, world: _World) -> None:
    code, _ = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "theirs", member="colleague"))
    assert code == status.HTTP_403_FORBIDDEN

    code, body = _call(client, world, "colleague", "POST", _POLICIES, json=_policy(world, "theirs", member="colleague"))
    assert code == status.HTTP_200_OK, body
    code, _ = _call(
        client,
        world,
        "member",
        "DELETE",
        f"{_POLICIES}/theirs",
        params={"workspace_id": str(world.workspaces["alpha_one"]), "member_id": str(world.users["colleague"])},
    )
    assert code == status.HTTP_403_FORBIDDEN
    assert ("theirs", str(world.users["colleague"])) in _listed(client, world, "colleague")


def test_a_member_writes_only_into_a_workspace_they_belong_to(client: TestClient, world: _World) -> None:
    code, _ = _call(
        client,
        world,
        "member",
        "POST",
        _POLICIES,
        json=_policy(world, "elsewhere", member="member", workspace="alpha_two"),
    )
    assert code == status.HTTP_404_NOT_FOUND


def test_user_id_is_still_refused(client: TestClient, world: _World) -> None:
    code, _ = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "raw", user_id="anyone"))
    assert code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_a_member_cannot_reach_a_target_their_organization_does_not(client: TestClient, world: _World) -> None:
    body = _policy(world, "unreachable", member="member")
    body["spec"] = {"select": [{"default": "anthropic:claude-3-5-haiku-latest"}]}
    code, _ = _call(client, world, "member", "POST", _POLICIES, json=body)
    assert code == status.HTTP_400_BAD_REQUEST


# =============================================================================
# The workspace setting
# =============================================================================


def test_members_may_create_policies_by_default(client: TestClient, world: _World) -> None:
    code, body = _call(
        client, world, "member", "GET", f"{API_ROOT}/workspaces/{world.workspaces['alpha_one']}/visibility"
    )
    assert code == status.HTTP_200_OK, body
    assert body["members_create_policies"] is True


def test_turned_off_a_member_cannot_create_but_keeps_editing_and_deleting(client: TestClient, world: _World) -> None:
    code, body = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "kept", member="member"))
    assert code == status.HTTP_200_OK, body
    _set_members_create(client, world, False)

    code, _ = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "new", member="member"))
    assert code == status.HTTP_403_FORBIDDEN

    edited = _policy(world, "kept", member="member")
    edited["spec"] = {"select": [{"default": _BACKUP}]}
    code, body = _call(client, world, "member", "POST", _POLICIES, json=edited)
    assert code == status.HTTP_200_OK, body
    assert body["spec"]["select"] == [{"default": _BACKUP}]

    code, _ = _call(
        client,
        world,
        "member",
        "DELETE",
        f"{_POLICIES}/kept",
        params={"workspace_id": str(world.workspaces["alpha_one"]), "member_id": str(world.users["member"])},
    )
    assert code == status.HTTP_204_NO_CONTENT


def test_turned_off_an_admin_still_writes_a_members_policy(client: TestClient, world: _World) -> None:
    _set_members_create(client, world, False)
    code, body = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "given", member="member"))
    assert code == status.HTTP_200_OK, body


def test_a_member_cannot_change_the_setting(client: TestClient, world: _World) -> None:
    code, _ = _call(
        client,
        world,
        "member",
        "PATCH",
        f"{API_ROOT}/workspaces/{world.workspaces['alpha_one']}/visibility",
        json={"members_create_policies": False},
    )
    assert code in (status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND)


# =============================================================================
# An owner or admin, for someone else
# =============================================================================


def test_an_admin_writes_lists_and_deletes_a_members_policy(client: TestClient, world: _World) -> None:
    code, body = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "assigned", member="member"))
    assert code == status.HTTP_200_OK, body
    assert ("assigned", str(world.users["member"])) in _listed(client, world, "member")

    code, _ = _call(
        client,
        world,
        "admin",
        "DELETE",
        f"{_POLICIES}/assigned",
        params={"workspace_id": str(world.workspaces["alpha_one"]), "member_id": str(world.users["member"])},
    )
    assert code == status.HTTP_204_NO_CONTENT
    assert ("assigned", str(world.users["member"])) not in _listed(client, world, "member")


@pytest.mark.parametrize("target", ["beta_owner", "unknown"])
def test_an_admin_cannot_scope_a_policy_to_someone_outside_the_organization(
    client: TestClient, world: _World, target: str
) -> None:
    body = _policy(world, "outsider")
    body["member_id"] = str(world.users[target]) if target in world.users else str(uuid.uuid4())
    code, response = _call(client, world, "admin", "POST", _POLICIES, json=body)
    assert code == status.HTTP_404_NOT_FOUND
    assert response["detail"] == "No such member in this organization."


def test_an_admin_cleans_up_after_a_member_who_left(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    code, body = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "left", member="member"))
    assert code == status.HTTP_200_OK, body
    session = db_session_factory()
    try:
        session.execute(
            update(OrganizationMember)
            .where(col(OrganizationMember.user_id) == world.users["member"])
            .values(status="suspended")
        )
        session.commit()
    finally:
        session.close()
    assert ("left", str(world.users["member"])) in _listed(client, world, "admin")

    code, _ = _call(
        client,
        world,
        "admin",
        "DELETE",
        f"{_POLICIES}/left",
        params={"workspace_id": str(world.workspaces["alpha_one"]), "member_id": str(world.users["member"])},
    )
    assert code == status.HTTP_204_NO_CONTENT


@pytest.mark.parametrize("target", ["beta_owner", "unknown"])
def test_an_admin_cannot_delete_a_row_the_operator_scoped_to_a_non_member(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session], target: str
) -> None:
    outsider = str(world.users[target]) if target in world.users else str(uuid.uuid4())
    session = db_session_factory()
    try:
        session.add(BillingUser(user_id=outsider, alias="Operator scoped"))
        session.commit()
        session.add(
            RoutingPolicy(
                name="operator-scoped",
                spec={"select": [{"default": _TARGET}]},
                user_id=outsider,
                workspace_id=world.workspaces["alpha_one"],
            )
        )
        session.commit()
    finally:
        session.close()
    assert ("operator-scoped", outsider) not in _listed(client, world, "admin")

    code, response = _call(
        client,
        world,
        "admin",
        "DELETE",
        f"{_POLICIES}/operator-scoped",
        params={"workspace_id": str(world.workspaces["alpha_one"]), "member_id": outsider},
    )
    assert code == status.HTTP_404_NOT_FOUND
    assert response["detail"] == "No such member in this organization."


def test_another_organization_never_sees_alphas_member_policies(client: TestClient, world: _World) -> None:
    code, body = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "private", member="member"))
    assert code == status.HTTP_200_OK, body
    assert not {row for row in _listed(client, world, "beta_owner") if row[0] == "private"}


def test_a_revoked_member_gets_no_policy(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    session = db_session_factory()
    try:
        session.add(BillingUser(user_id=str(world.users["member"]), alias="Member"))
        session.commit()
        session.execute(
            update(BillingUser)
            .where(BillingUser.user_id == str(world.users["member"]))
            .values(deleted_at=datetime.now(UTC))
        )
        session.commit()
    finally:
        session.close()
    code, body = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "revoked", member="member"))
    assert code == status.HTTP_409_CONFLICT, body


# =============================================================================
# Make my own version
# =============================================================================


def test_a_member_makes_their_own_version_of_a_shared_policy(client: TestClient, world: _World) -> None:
    code, body = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "shared"))
    assert code == status.HTTP_200_OK, body
    copy = {"name": "shared", "workspace_id": str(world.workspaces["alpha_one"])}

    code, body = _call(client, world, "member", "POST", f"{_POLICIES}/copy", json=copy)
    assert code == status.HTTP_200_OK, body
    assert (body["name"], body["user_id"]) == ("shared", str(world.users["member"]))
    assert body["spec"]["on_failure"] == [_BACKUP]
    assert {("shared", None), ("shared", str(world.users["member"]))} <= _listed(client, world, "member")

    code, _ = _call(client, world, "member", "POST", f"{_POLICIES}/copy", json=copy)
    assert code == status.HTTP_409_CONFLICT


def test_there_is_nothing_to_copy_without_a_shared_policy(client: TestClient, world: _World) -> None:
    copy = {"name": "nowhere", "workspace_id": str(world.workspaces["alpha_one"])}
    code, _ = _call(client, world, "member", "POST", f"{_POLICIES}/copy", json=copy)
    assert code == status.HTTP_404_NOT_FOUND


def test_turned_off_a_member_cannot_make_their_own_version(client: TestClient, world: _World) -> None:
    code, body = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "locked"))
    assert code == status.HTTP_200_OK, body
    _set_members_create(client, world, False)
    copy = {"name": "locked", "workspace_id": str(world.workspaces["alpha_one"])}
    code, _ = _call(client, world, "member", "POST", f"{_POLICIES}/copy", json=copy)
    assert code == status.HTTP_403_FORBIDDEN


# =============================================================================
# Turning an alias into a policy
# =============================================================================


def test_an_admin_turns_an_alias_into_a_policy_in_one_step(client: TestClient, world: _World) -> None:
    alias = {"name": "fast", "target": _TARGET, "workspace_id": str(world.workspaces["alpha_one"])}
    code, body = _call(client, world, "admin", "POST", _ALIASES, json=alias)
    assert code == status.HTTP_200_OK, body

    code, _ = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "fast"))
    assert code == status.HTTP_400_BAD_REQUEST

    code, body = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "fast", replaces_alias=True))
    assert code == status.HTTP_200_OK, body
    assert ("fast", None) in _listed(client, world, "admin")
    code, aliases = _call(client, world, "admin", "GET", _ALIASES)
    assert code == status.HTTP_200_OK
    assert "fast" not in {row["name"] for row in aliases if row["source"] == "stored"}


def test_replacing_needs_the_workspaces_own_alias(client: TestClient, world: _World) -> None:
    code, _ = _call(client, world, "admin", "POST", _POLICIES, json=_policy(world, "absent", replaces_alias=True))
    assert code == status.HTTP_404_NOT_FOUND


def test_replacing_an_alias_is_an_admins_and_workspace_wide(client: TestClient, world: _World) -> None:
    code, _ = _call(
        client, world, "member", "POST", _POLICIES, json=_policy(world, "fast", member="member", replaces_alias=True)
    )
    assert code == status.HTTP_422_UNPROCESSABLE_CONTENT
    code, _ = _call(client, world, "member", "POST", _POLICIES, json=_policy(world, "fast", replaces_alias=True))
    assert code == status.HTTP_403_FORBIDDEN
