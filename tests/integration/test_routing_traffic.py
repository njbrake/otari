"""Who sent each routing name, and what each step did: ``/routing-policies/traffic`` and Sent by on the fallbacks.

Alpha has two workspaces. A member and a colleague in the first each send a
stored policy and a catalog ID; a workspace admin manages the first only; Beta
is another organization. A row names the policy it was sent as in
``policy_name``, which is what the read groups by. Whose traffic a caller reads:
everyone's to an owner or admin, a workspace's to its own owners and admins, and
otherwise the caller's own, so a member never learns a colleague's keys from it. Each assertion names what must
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

from gateway.api.routes import organization_routing
from gateway.auth.models import hash_key
from gateway.core.config import API_ROOT, GatewayConfig
from gateway.models.api_keys import APIKey
from gateway.models.routing import PolicySpec, RoutingPolicy
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
_GEMINI = "gemini:gemini-x"
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
    reason: str | None = None,
) -> UsageLog:
    provider, _, model = served.partition(":")
    return UsageLog(
        id=str(uuid.uuid4()),
        workspace_id=workspace_id,
        api_key_id=key_id,
        user_id=str(owner),
        model=model,
        provider=provider,
        policy_name=sent,
        attempt_position=position,
        selection_reason=reason or ("default" if position == 1 else "on_failure"),
        endpoint="/v1/chat/completions",
        source="gateway",
        status=status_,
        timestamp=datetime.now(UTC) - timedelta(hours=1),
    )


def _sends(workspace_id: uuid.UUID, key_id: str, owner: uuid.UUID) -> list[UsageLog]:
    """Through the policy: one answered first time, one that failed over to step 2; plus a catalog ID."""
    return [
        _attempt(workspace_id, key_id, owner, "fast", _ANTHROPIC, position=1),
        _attempt(workspace_id, key_id, owner, "fast", _ANTHROPIC, position=1, status_="absorbed"),
        _attempt(workspace_id, key_id, owner, "fast", _BEDROCK, position=2),
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
                    key_name=f"{owner}-key",
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
        session.add_all(
            [
                *_sends(one.id, built.keys["member"], built.users["member"]),
                *_sends(one.id, built.keys["colleague"], built.users["colleague"]),
                *_sends(two.id, built.keys["two_member"], built.users["two_member"]),
                *_sends(beta_one.id, built.keys["beta"], built.users["beta_owner"]),
                # A name no policy claims is not routing traffic.
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


def _traffic(client: TestClient, world: _World, who: str, **params: Any) -> dict[tuple[str, str], Any]:
    body = _get(client, world, who, _TRAFFIC, params)
    assert body["window_days"] == 30
    names = {world.workspaces[k]: k for k in world.workspaces}
    return {(names[uuid.UUID(item["workspace_id"])], item["name"]): item for item in body["names"]}


def _senders(world: _World, item: dict[str, Any]) -> set[str]:
    owners = {key: who for who, key in world.keys.items()}
    return {owners[row["api_key_id"]] for row in item["sent_by"]}


def test_an_owner_reads_everyones_traffic_with_its_keys_and_steps(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "owner")

    assert set(traffic) == {("one", "fast"), ("two", "fast")}
    fast = traffic[("one", "fast")]
    assert fast["requests"] == 4
    assert sorted(fast["sent_by"], key=lambda row: row["key_name"]) == [
        {"api_key_id": world.keys["colleague"], "key_name": "colleague-key", "requests": 2},
        {"api_key_id": world.keys["member"], "key_name": "member-key", "requests": 2},
    ]
    assert fast["steps"] == [
        {"target": _ANTHROPIC, "role": "default", "router": None, "position": 1, "served": 2, "failed": 2},
        {"target": _BEDROCK, "role": "on_failure", "router": None, "position": 2, "served": 2, "failed": 0},
    ]


def test_a_name_counts_only_where_it_routes(
    traffic_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """A policy stored in one workspace says nothing about the same name sent in another, where it is a model name."""
    session = db_session_factory()
    try:
        session.add(
            RoutingPolicy(
                name="only-one",
                spec={"select": [{"default": _ANTHROPIC}]},
                workspace_id=world.workspaces["one"],
            )
        )
        session.add_all(
            [
                _attempt(
                    world.workspaces["one"],
                    world.keys["member"],
                    world.users["member"],
                    "only-one",
                    _ANTHROPIC,
                    position=1,
                ),
                _attempt(
                    world.workspaces["two"],
                    world.keys["two_member"],
                    world.users["two_member"],
                    "only-one",
                    _ANTHROPIC,
                    position=1,
                ),
            ]
        )
        session.commit()
    finally:
        session.close()

    traffic = _traffic(traffic_client, world, "owner")
    assert traffic[("one", "only-one")]["requests"] == 1
    assert ("two", "only-one") not in traffic


def test_a_configured_policy_counts_in_every_workspace(
    traffic_client: TestClient,
    world: _World,
    test_config: GatewayConfig,
    db_session_factory: Callable[[], Session],
) -> None:
    """A ``config.yml`` policy has no workspace, so no stored row has to claim it for its traffic to count."""
    test_config.routing.policies["configured-policy"] = PolicySpec.model_validate({"select": [{"default": _ANTHROPIC}]})
    try:
        session = db_session_factory()
        try:
            session.add_all(
                [
                    _attempt(
                        world.workspaces[workspace],
                        world.keys[who],
                        world.users[who],
                        "configured-policy",
                        _ANTHROPIC,
                        position=1,
                    )
                    for workspace, who in (("one", "member"), ("two", "two_member"))
                ]
            )
            session.commit()
        finally:
            session.close()

        traffic = _traffic(traffic_client, world, "owner")
        assert traffic[("one", "configured-policy")]["requests"] == 1
        assert traffic[("two", "configured-policy")]["requests"] == 1
    finally:
        del test_config.routing.policies["configured-policy"]


def test_at_the_cap_the_names_counted_are_the_first_by_name(
    traffic_client: TestClient,
    world: _World,
    db_session_factory: Callable[[], Session],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The cap counts (workspace, name) pairs, so it keeps the rows the name-ordered policy list shows first."""
    monkeypatch.setattr(organization_routing, "_MAX_ROWS", 2)
    session = db_session_factory()
    try:
        for workspace, who in (("one", "member"), ("two", "two_member")):
            session.add(
                RoutingPolicy(
                    name="a-first",
                    spec={"select": [{"default": _ANTHROPIC}]},
                    workspace_id=world.workspaces[workspace],
                )
            )
            session.add(
                _attempt(
                    world.workspaces[workspace], world.keys[who], world.users[who], "a-first", _ANTHROPIC, position=1
                )
            )
        session.commit()
    finally:
        session.close()

    traffic = _traffic(traffic_client, world, "owner")
    assert set(traffic) == {("one", "a-first"), ("two", "a-first")}


def test_a_member_reads_only_their_own(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "member")
    assert set(traffic) == {("one", "fast")}
    assert _senders(world, traffic[("one", "fast")]) == {"member"}
    assert traffic[("one", "fast")]["requests"] == 2


def test_a_workspace_admin_reads_everyone_in_their_workspace_only(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "ws_admin")
    assert set(traffic) == {("one", "fast")}
    assert _senders(world, traffic[("one", "fast")]) == {"member", "colleague"}


def test_a_workspace_admin_reads_only_their_own_where_they_are_a_member(
    traffic_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    session = db_session_factory()
    try:
        session.add(
            WorkspaceMember(
                workspace_id=world.workspaces["two"], user_id=world.users["ws_admin"], role="member", status="active"
            )
        )
        session.commit()
    finally:
        session.close()

    traffic = _traffic(traffic_client, world, "ws_admin")
    assert set(traffic) == {("one", "fast")}
    assert _senders(world, traffic[("one", "fast")]) == {"member", "colleague"}


def test_an_abandoned_stream_is_served_not_failed(
    traffic_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    session = db_session_factory()
    try:
        session.add(
            _attempt(
                world.workspaces["two"],
                world.keys["two_member"],
                world.users["two_member"],
                "fast",
                _ANTHROPIC,
                position=1,
                status_="incomplete",
            )
        )
        session.commit()
    finally:
        session.close()

    fast = _traffic(traffic_client, world, "owner")[("two", "fast")]
    assert fast["requests"] == 3
    assert fast["steps"][0] == {
        "target": _ANTHROPIC,
        "role": "default",
        "router": None,
        "position": 1,
        "served": 2,
        "failed": 1,
    }


def test_the_key_filter_narrows_and_never_widens(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "owner", api_key_id=[world.keys["colleague"]])
    assert set(traffic) == {("one", "fast")}
    assert _senders(world, traffic[("one", "fast")]) == {"colleague"}

    assert _traffic(traffic_client, world, "member", api_key_id=[world.keys["colleague"]]) == {}


def test_the_workspace_filter_narrows_and_never_widens(traffic_client: TestClient, world: _World) -> None:
    traffic = _traffic(traffic_client, world, "owner", workspace_id=str(world.workspaces["two"]))
    assert set(traffic) == {("two", "fast")}

    assert _traffic(traffic_client, world, "owner", workspace_id=str(world.workspaces["beta"])) == {}


def test_another_organization_reads_nothing_of_alphas(traffic_client: TestClient, world: _World) -> None:
    body = _get(traffic_client, world, "beta_owner", _TRAFFIC)
    assert {row["api_key_id"] for item in body["names"] for row in item["sent_by"]} == {world.keys["beta"]}


def test_fallbacks_name_the_keys_a_reader_may_see(traffic_client: TestClient, world: _World) -> None:
    def sent_by(who: str, **params: Any) -> list[dict[str, Any]]:
        models = {model["id"]: model for model in _get(traffic_client, world, who, _FALLBACKS, params)["models"]}
        return models[_CLAUDE]["sent_by"] if _CLAUDE in models else []

    owner = {row["api_key_id"] for row in sent_by("owner")}
    assert owner == {world.keys["member"], world.keys["colleague"], world.keys["two_member"]}

    # A member's counts stay their workspace's, but the keys named are theirs alone. Every request that reached
    # one of Claude's offerings counts, policy ones included: four from the member, three in workspace two.
    assert sent_by("member") == [{"api_key_id": world.keys["member"], "key_name": "member-key", "requests": 4}]

    assert sent_by("owner", api_key_id=[world.keys["two_member"]]) == [
        {"api_key_id": world.keys["two_member"], "key_name": "two_member-key", "requests": 3}
    ]
    assert sent_by("member", api_key_id=[world.keys["colleague"]]) == []


def test_the_reads_need_a_signed_in_caller(traffic_client: TestClient, world: _World) -> None:
    assert traffic_client.get(_TRAFFIC).status_code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)


def _steps_of(client: TestClient, world: _World, name: str) -> list[tuple[str, str, int, int, int]]:
    item = _traffic(client, world, "owner")[("one", name)]
    return [(step["target"], step["role"], step["position"], step["served"], step["failed"]) for step in item["steps"]]


def _store(db_session_factory: Callable[[], Session], rows: list[UsageLog], world: _World, name: str) -> None:
    session = db_session_factory()
    try:
        session.add(
            RoutingPolicy(name=name, spec={"select": [{"default": _ANTHROPIC}]}, workspace_id=world.workspaces["one"])
        )
        session.add_all(rows)
        session.commit()
    finally:
        session.close()


def test_a_routers_picks_are_counted_by_what_served_not_by_place(
    traffic_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """A weighted router ranks its pool per request, so place 1 is Anthropic on one request and Bedrock on another."""
    one, key, owner = world.workspaces["one"], world.keys["member"], world.users["member"]

    def at(served: str, position: int, reason: str, status_: str = "success") -> UsageLog:
        return _attempt(one, key, owner, "split", served, position=position, status_=status_, reason=reason)

    _store(
        db_session_factory,
        [
            # Anthropic first and answered; Bedrock first and answered.
            at(_ANTHROPIC, 1, "router:weighted"),
            at(_BEDROCK, 1, "router:weighted"),
            # Bedrock first and failed, the router's second pick Anthropic answered.
            at(_BEDROCK, 1, "router:weighted", "absorbed"),
            at(_ANTHROPIC, 2, "router:weighted"),
            # Both picks failed, the backup after them answered.
            at(_ANTHROPIC, 1, "router:weighted", "absorbed"),
            at(_BEDROCK, 2, "router:weighted", "absorbed"),
            at(_GEMINI, 3, "on_failure"),
        ],
        world,
        "split",
    )

    assert _steps_of(traffic_client, world, "split") == [
        (_ANTHROPIC, "routed", 1, 2, 1),
        (_BEDROCK, "routed", 1, 1, 2),
        (_GEMINI, "on_failure", 3, 1, 0),
    ]
    item = _traffic(traffic_client, world, "owner")[("one", "split")]
    assert {step["router"] for step in item["steps"] if step["role"] == "routed"} == {"weighted"}


def test_a_router_that_declines_serves_the_default_then_the_backup(
    traffic_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    one, key, owner = world.workspaces["one"], world.keys["member"], world.users["member"]
    _store(
        db_session_factory,
        [
            _attempt(one, key, owner, "declined", _ANTHROPIC, position=1, status_="absorbed", reason="default"),
            _attempt(one, key, owner, "declined", _GEMINI, position=2, reason="on_failure"),
        ],
        world,
        "declined",
    )

    assert _steps_of(traffic_client, world, "declined") == [
        (_ANTHROPIC, "default", 1, 0, 1),
        (_GEMINI, "on_failure", 2, 1, 0),
    ]


def test_a_dropped_candidate_leaves_the_backup_named_as_a_backup(
    traffic_client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """A key that may not reach the default target compiles to its backup alone, which then runs first."""
    one, key, owner = world.workspaces["one"], world.keys["member"], world.users["member"]
    _store(
        db_session_factory,
        [
            _attempt(one, key, owner, "narrowed", _BEDROCK, position=1, reason="on_failure"),
            _attempt(one, key, owner, "narrowed", _ANTHROPIC, position=1, reason="default"),
        ],
        world,
        "narrowed",
    )

    assert _steps_of(traffic_client, world, "narrowed") == [
        (_ANTHROPIC, "default", 1, 1, 0),
        (_BEDROCK, "on_failure", 1, 1, 0),
    ]
