"""Who sent each routing name, and what each step did: ``/routing-policies/traffic`` and Sent by on the fallbacks.

Alpha has two workspaces. A member and a colleague in the first each send a
stored policy, a stored alias and a catalog ID; a workspace admin manages the
first only; Beta is another organization. Whose traffic a caller reads is the
rule the organization's usage reads draw: everyone's to an owner or admin, a
workspace's to its own owners and admins, and otherwise the caller's own, so a
member never learns a colleague's keys from it. Each assertion names what must
be absent as well as what is there.
"""

import uuid
from collections.abc import Callable, Generator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from gateway.auth.models import hash_key
from gateway.core.config import API_ROOT, GatewayConfig
from gateway.models.api_keys import APIKey
from gateway.models.providers import ModelAlias
from gateway.models.routing import RoutingPolicy
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User, Workspace, WorkspaceMember
from gateway.models.usage import UsageLog
from gateway.models.users import User as BillingUser
from gateway.services import catalog as selectors
from gateway.services import selector_index_service
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

from .conftest import build_test_client

_TRAFFIC = f"{API_ROOT}/organizations/me/routing-policies/traffic"
_FALLBACKS = f"{API_ROOT}/organizations/me/automatic-fallbacks"

_CLAUDE = "anthropic/claude-x"
_ANTHROPIC = "anthropic:claude-x-1"
_BEDROCK = "bedrock:anthropic.claude-x-1"
_ROWS = [
    selectors.OfferingRow(_ANTHROPIC, "anthropic", "anthropic", 3.0),
    selectors.OfferingRow(_BEDROCK, "bedrock", "bedrock", 2.0),
]
_IDENTITIES: dict[str, tuple[str, tuple[str, ...]]] = {_CLAUDE: ("claudex", (_ANTHROPIC, _BEDROCK))}


@dataclass
class _World:
    workspaces: dict[str, uuid.UUID] = field(default_factory=dict)
    users: dict[str, uuid.UUID] = field(default_factory=dict)
    sessions: dict[str, str] = field(default_factory=dict)
    keys: dict[str, str] = field(default_factory=dict)


@pytest.fixture
def traffic_client(
    test_config: GatewayConfig, clean_database: None, monkeypatch: pytest.MonkeyPatch
) -> Generator[TestClient]:
    """A client whose selector index is the one the test sets, not one the refresher rebuilds over it."""

    async def _keep(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(selector_index_service, "rebuild_selector_index", _keep)
    yield from build_test_client(test_config)


def _identity(
    session: Session,
    *,
    email: str,
    organization_id: uuid.UUID,
    role: str = "member",
    workspaces: tuple[tuple[uuid.UUID, str], ...] = (),
) -> tuple[uuid.UUID, str]:
    user = User(email=email, full_name=email.split("@")[0].title(), active_organization_id=organization_id)
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(OrganizationMember(organization_id=organization_id, user_id=user.id, role=role, status="active"))
    for workspace_id, workspace_role in workspaces:
        session.add(WorkspaceMember(workspace_id=workspace_id, user_id=user.id, role=workspace_role, status="active"))
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


def _attempt(
    workspace_id: uuid.UUID,
    key_id: str,
    owner: uuid.UUID,
    sent: str,
    served: str,
    *,
    position: int,
    status_: str = "success",
    policy_name: str | None = None,
) -> UsageLog:
    provider, _, model = served.partition(":")
    return UsageLog(
        id=str(uuid.uuid4()),
        workspace_id=workspace_id,
        api_key_id=key_id,
        user_id=str(owner),
        model=model,
        provider=provider,
        requested_model=sent,
        policy_name=policy_name if policy_name is not None else sent,
        attempt_position=position,
        endpoint="/v1/chat/completions",
        source="gateway",
        status=status_,
        timestamp=datetime.now(UTC) - timedelta(hours=1),
    )


def _sends(workspace_id: uuid.UUID, key_id: str, owner: uuid.UUID) -> list[UsageLog]:
    """Through the policy: one answered first time, one that failed over to step 2; plus an alias and a catalog ID."""
    return [
        _attempt(workspace_id, key_id, owner, "fast", _ANTHROPIC, position=1),
        _attempt(workspace_id, key_id, owner, "fast", _ANTHROPIC, position=1, status_="absorbed"),
        _attempt(workspace_id, key_id, owner, "fast", _BEDROCK, position=2),
        _attempt(workspace_id, key_id, owner, "short", _ANTHROPIC, position=1, policy_name=""),
        _attempt(workspace_id, key_id, owner, _CLAUDE, _ANTHROPIC, position=1),
    ]


@pytest.fixture
def world(
    traffic_client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]
) -> _World:
    assert (
        traffic_client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK
    )
    session = db_session_factory()
    try:
        alpha = Organization(name="Alpha", slug="alpha")
        beta = Organization(name="Beta", slug="beta")
        session.add_all([alpha, beta])
        session.commit()
        one = Workspace(name="Alpha one", organization_id=alpha.id)
        two = Workspace(name="Alpha two", organization_id=alpha.id)
        beta_one = Workspace(name="Beta one", organization_id=beta.id)
        session.add_all([one, two, beta_one])
        session.commit()

        built = _World(workspaces={"one": one.id, "two": two.id, "beta": beta_one.id})
        people = {
            "owner": _identity(session, email="owner@alpha.test", organization_id=alpha.id, role="owner"),
            "ws_admin": _identity(
                session, email="wsadmin@alpha.test", organization_id=alpha.id, workspaces=((one.id, "admin"),)
            ),
            "member": _identity(
                session, email="member@alpha.test", organization_id=alpha.id, workspaces=((one.id, "member"),)
            ),
            "colleague": _identity(
                session, email="colleague@alpha.test", organization_id=alpha.id, workspaces=((one.id, "member"),)
            ),
            "two_member": _identity(
                session, email="two@alpha.test", organization_id=alpha.id, workspaces=((two.id, "member"),)
            ),
            "beta_owner": _identity(session, email="owner@beta.test", organization_id=beta.id, role="owner"),
        }
        built.users = {name: user_id for name, (user_id, _) in people.items()}
        built.sessions = {name: token for name, (_, token) in people.items()}

        def key(workspace_id: uuid.UUID, owner: str) -> str:
            key_id = str(uuid.uuid4())
            session.add(
                APIKey(
                    id=key_id,
                    workspace_id=workspace_id,
                    key_hash=hash_key(key_id),
                    user_id=str(built.users[owner]),
                )
            )
            session.commit()
            return key_id

        built.keys = {
            "member": key(one.id, "member"),
            "colleague": key(one.id, "colleague"),
            "two_member": key(two.id, "two_member"),
            "beta": key(beta_one.id, "beta_owner"),
        }
        for workspace_id in (one.id, two.id, beta_one.id):
            session.add(
                RoutingPolicy(
                    name="fast",
                    spec={"select": [{"default": _ANTHROPIC}], "on_failure": [_BEDROCK]},
                    workspace_id=workspace_id,
                )
            )
            session.add(ModelAlias(name="short", target=_ANTHROPIC, workspace_id=workspace_id))
        session.add_all(
            [
                *_sends(one.id, built.keys["member"], built.users["member"]),
                *_sends(one.id, built.keys["colleague"], built.users["colleague"]),
                *_sends(two.id, built.keys["two_member"], built.users["two_member"]),
                *_sends(beta_one.id, built.keys["beta"], built.users["beta_owner"]),
                # A name that is neither a policy nor an alias is not routing traffic.
                _attempt(one.id, built.keys["member"], built.users["member"], "gpt-direct", _ANTHROPIC, position=1),
            ]
        )
        session.commit()
        selectors.set_selector_index(selectors.build_selector_index(_ROWS, _IDENTITIES, names={_CLAUDE: "Claude X"}))
        return built
    finally:
        session.close()


def _get(client: TestClient, world: _World, who: str, path: str, params: dict[str, Any] | None = None) -> Any:
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions[who])
    try:
        response = client.get(path, params=params)
    finally:
        client.cookies.clear()
    assert response.status_code == status.HTTP_200_OK, response.text
    return response.json()


def _traffic(client: TestClient, world: _World, who: str, **params: Any) -> dict[tuple[str, str, str], Any]:
    body = _get(client, world, who, _TRAFFIC, params)
    assert body["window_days"] == 30
    names = {world.workspaces[k]: k for k in world.workspaces}
    people = {str(v): k for k, v in world.users.items()}
    return {
        (names[uuid.UUID(item["workspace_id"])], item["name"], people[item["user_id"]]): item for item in body["names"]
    }


def test_an_owner_reads_everyones_traffic_with_its_keys_and_steps(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "owner")

    assert set(traffic) == {
        (workspace, name, who)
        for workspace, who in (("one", "member"), ("one", "colleague"), ("two", "two_member"))
        for name in ("fast", "short")
    }
    fast = traffic[("one", "fast", "member")]
    assert fast["requests"] == 2
    assert fast["sent_by"] == [{"api_key_id": world.keys["member"], "requests": 2}]
    assert fast["steps"] == [
        {"position": 1, "served": 1, "failed": 1},
        {"position": 2, "served": 1, "failed": 0},
    ]
    assert traffic[("one", "short", "member")]["steps"] == [{"position": 1, "served": 1, "failed": 0}]


def test_a_member_reads_only_their_own(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "member")
    assert set(traffic) == {("one", "fast", "member"), ("one", "short", "member")}


def test_a_workspace_admin_reads_everyone_in_their_workspace_only(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "ws_admin")
    assert {(workspace, who) for workspace, _, who in traffic} == {("one", "member"), ("one", "colleague")}


def test_the_key_filter_narrows_and_never_widens(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "owner", api_key_id=[world.keys["colleague"]])
    assert {who for _, _, who in traffic} == {"colleague"}

    assert _traffic(traffic_client, world, "member", api_key_id=[world.keys["colleague"]]) == {}


def test_the_workspace_filter_narrows_and_never_widens(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "owner", workspace_id=str(world.workspaces["two"]))
    assert {workspace for workspace, _, _ in traffic} == {"two"}

    assert _traffic(traffic_client, world, "owner", workspace_id=str(world.workspaces["beta"])) == {}


def test_another_organization_reads_nothing_of_alphas(traffic_client: TestClient, world: _World) -> None:
    body = _get(traffic_client, world, "beta_owner", _TRAFFIC)
    users = {item["user_id"] for item in body["names"]}
    assert users == {str(world.users["beta_owner"])}


def test_fallbacks_name_the_keys_a_reader_may_see(traffic_client: TestClient, world: _World) -> None:
    def sent_by(who: str, **params: Any) -> list[dict[str, Any]]:
        models = {model["id"]: model for model in _get(traffic_client, world, who, _FALLBACKS, params)["models"]}
        return models[_CLAUDE]["sent_by"] if _CLAUDE in models else []

    owner = {row["api_key_id"] for row in sent_by("owner")}
    assert owner == {world.keys["member"], world.keys["colleague"], world.keys["two_member"]}

    # A member's counts stay their workspace's, but the keys named are theirs alone. Every request that reached
    # one of Claude's offerings counts, policy and alias ones included: five from the member, four elsewhere.
    assert sent_by("member") == [{"api_key_id": world.keys["member"], "requests": 5}]

    assert sent_by("owner", api_key_id=[world.keys["two_member"]]) == [
        {"api_key_id": world.keys["two_member"], "requests": 4}
    ]
    assert sent_by("member", api_key_id=[world.keys["colleague"]]) == []


def test_the_reads_need_a_signed_in_caller(traffic_client: TestClient, world: _World) -> None:
    assert traffic_client.get(_TRAFFIC).status_code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)
