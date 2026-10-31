"""``GET /api/v1/keys/routing`` and ``GET /api/v1/organizations/me/keys/routing``: what each key sent, and its backups.

One organization with two members in one workspace, and a second organization.
The member's key sends a catalog ID with two offerings, one with a single
offering, a pinned offering, a policy with a backup, a policy without one, an
alias and imported usage; a second key of theirs is narrowed to one provider,
which leaves a catalog ID and a policy one candidate each.
Each assertion names what must be absent as well as what is there.
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
from gateway.models.routing import RoutingConfig
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User, Workspace, WorkspaceMember
from gateway.models.usage import UsageLog
from gateway.models.users import User as BillingUser
from gateway.services import catalog as selectors
from gateway.services import selector_index_service
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

from .conftest import build_test_client, refresh_usage_rollups

_OPERATOR_PATH = f"{API_ROOT}/keys/routing"
_MEMBER_PATH = f"{API_ROOT}/organizations/me/keys/routing"

_CLAUDE = "anthropic/claude-x"
_GEMINI = "google/gemini-x"
_ANTHROPIC = "anthropic:claude-x-1"
_BEDROCK = "bedrock:anthropic.claude-x-1"
_GEMINI_OFFERING = "gemini:gemini-x"

_ROWS = [
    selectors.OfferingRow(_ANTHROPIC, "anthropic", "anthropic", 3.0),
    selectors.OfferingRow(_BEDROCK, "bedrock", "bedrock", 2.0),
    selectors.OfferingRow(_GEMINI_OFFERING, "gemini", "gemini", 1.0),
]
_IDENTITIES: dict[str, tuple[str, tuple[str, ...]]] = {
    _CLAUDE: ("claudex", (_ANTHROPIC, _BEDROCK)),
    _GEMINI: ("geminix", (_GEMINI_OFFERING,)),
}
_NAMES = {_CLAUDE: "Claude X", _GEMINI: "Gemini X"}


@dataclass
class _World:
    keys: dict[str, str] = field(default_factory=dict)
    sessions: dict[str, str] = field(default_factory=dict)


@pytest.fixture
def routing_client(
    test_config: GatewayConfig, clean_database: None, monkeypatch: pytest.MonkeyPatch
) -> Generator[TestClient]:
    """A client with two policies and an alias, whose selector index is the one the test sets."""

    async def _keep(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(selector_index_service, "rebuild_selector_index", _keep)
    config = test_config.model_copy(
        update={
            "routing": RoutingConfig.model_validate(
                {
                    "policies": {
                        "paired": {"select": [{"default": _ANTHROPIC}], "on_failure": [_BEDROCK]},
                        "solo": {"select": [{"default": _GEMINI_OFFERING}]},
                    }
                }
            ),
            "aliases": {"fast": _CLAUDE},
        }
    )
    yield from build_test_client(config)


def _identity(
    session: Session, *, email: str, organization_id: uuid.UUID, workspace_ids: tuple[uuid.UUID, ...] = ()
) -> tuple[str, str]:
    """A member with a live dashboard session and the billing row their keys hang off; their user id and cookie."""
    user = User(email=email, full_name=email.split("@")[0].title(), active_organization_id=organization_id)
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(OrganizationMember(organization_id=organization_id, user_id=user.id, role="member", status="active"))
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
    return str(user.id), token


def _key(session: Session, workspace_id: uuid.UUID, owner: str, *, allowed_models: list[str] | None = None) -> str:
    key_id = str(uuid.uuid4())
    session.add(
        APIKey(
            id=key_id,
            workspace_id=workspace_id,
            key_hash=hash_key(key_id),
            key_name=f"key-{key_id[:8]}",
            user_id=owner,
            allowed_models=allowed_models,
        )
    )
    session.commit()
    return key_id


def _rows(
    workspace_id: uuid.UUID,
    key_id: str,
    sent: str | None,
    served: str,
    *,
    count: int = 1,
    status_: str = "success",
    source: str = "gateway",
    age: timedelta = timedelta(hours=1),
) -> list[UsageLog]:
    provider, _, model = served.partition(":")
    return [
        UsageLog(
            id=str(uuid.uuid4()),
            workspace_id=workspace_id,
            api_key_id=key_id,
            model=model,
            provider=provider,
            requested_model=sent,
            endpoint="/v1/chat/completions",
            source=source,
            status=status_,
            timestamp=datetime.now(UTC) - age,
        )
        for _ in range(count)
    ]


@pytest.fixture
def world(
    routing_client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]
) -> _World:
    assert (
        routing_client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK
    )
    session = db_session_factory()
    try:
        alpha = Organization(name="Alpha", slug="alpha")
        beta = Organization(name="Beta", slug="beta")
        session.add_all([alpha, beta])
        session.commit()
        alpha_one = Workspace(name="Alpha one", organization_id=alpha.id)
        beta_one = Workspace(name="Beta one", organization_id=beta.id)
        session.add_all([alpha_one, beta_one])
        session.commit()

        member, member_session = _identity(
            session, email="member@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
        )
        colleague, colleague_session = _identity(
            session, email="colleague@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
        )
        stranger, _ = _identity(session, email="owner@beta.test", organization_id=beta.id)

        app = _key(session, alpha_one.id, member)
        narrow = _key(session, alpha_one.id, member, allowed_models=["anthropic:*"])
        idle = _key(session, alpha_one.id, member)
        theirs = _key(session, alpha_one.id, colleague)
        foreign = _key(session, beta_one.id, stranger)

        session.add_all(
            [
                *_rows(alpha_one.id, app, _CLAUDE, _ANTHROPIC, count=5),
                # A failed attempt a later one recovered from is not a request of its own.
                *_rows(alpha_one.id, app, _CLAUDE, _ANTHROPIC, status_="absorbed"),
                *_rows(alpha_one.id, app, "paired", _ANTHROPIC, count=4),
                *_rows(alpha_one.id, app, "solo", _GEMINI_OFFERING, count=3),
                *_rows(alpha_one.id, app, _GEMINI, _GEMINI_OFFERING, count=2),
                *_rows(alpha_one.id, app, "fast", _ANTHROPIC, count=2),
                *_rows(alpha_one.id, app, _BEDROCK, _BEDROCK),
                *_rows(alpha_one.id, app, "retired-name", _ANTHROPIC),
                # Imported usage reports only the model that ran.
                *_rows(alpha_one.id, app, None, "anthropic:claude-opus-x", count=6, source="claude_code"),
                # Outside the window, and a side-call no caller named: neither counts.
                *_rows(alpha_one.id, app, "old-name", _ANTHROPIC, age=timedelta(days=40)),
                *_rows(alpha_one.id, app, None, _GEMINI_OFFERING),
                *_rows(alpha_one.id, narrow, _CLAUDE, _ANTHROPIC, count=2),
                *_rows(alpha_one.id, narrow, "paired", _ANTHROPIC),
                *_rows(alpha_one.id, theirs, _CLAUDE, _ANTHROPIC),
                *_rows(beta_one.id, foreign, _CLAUDE, _ANTHROPIC),
            ]
        )
        session.commit()

        selectors.set_selector_index(selectors.build_selector_index(_ROWS, _IDENTITIES, names=_NAMES))
        return _World(
            keys={"app": app, "narrow": narrow, "idle": idle, "theirs": theirs, "foreign": foreign},
            sessions={"member": member_session, "colleague": colleague_session},
        )
    finally:
        session.close()


def _read_as(client: TestClient, world: _World, who: str, key_ids: list[str]) -> list[dict[str, Any]]:
    response = client.get(
        _MEMBER_PATH, params={"api_key_id": key_ids}, cookies={SESSION_COOKIE_NAME: world.sessions[who]}
    )
    assert response.status_code == status.HTTP_200_OK, response.text
    body = response.json()
    assert body["window_days"] == 30
    keys: list[dict[str, Any]] = body["keys"]
    return keys


def test_each_name_a_key_sent_says_whether_a_failure_has_a_backup(routing_client: TestClient, world: _World) -> None:
    [app] = _read_as(routing_client, world, "member", [world.keys["app"]])

    assert app["api_key_id"] == world.keys["app"]
    models = {model["name"]: model for model in app["models"]}
    assert [model["name"] for model in app["models"]] == [
        "claude-opus-x",
        _CLAUDE,
        "paired",
        "solo",
        "fast",
        _GEMINI,
        _BEDROCK,
        "retired-name",
    ]
    assert "old-name" not in models

    def coverage(name: str) -> tuple[Any, ...]:
        model = models[name]
        return model["requests"], model["kind"], model["backup"], model["reason"], model["provider"]

    assert coverage(_CLAUDE) == (5, "catalog", "has_backup", None, None)
    assert coverage(_GEMINI) == (2, "catalog", "no_backup", "single_offering", "gemini")
    assert coverage("paired") == (4, "policy", "has_backup", None, None)
    assert coverage("solo") == (3, "policy", "no_backup", "single_target_policy", "gemini")
    # An alias is sent as written, so the catalog ID it names fails over to nothing.
    assert coverage("fast") == (2, "alias", "no_backup", "single_target_policy", None)
    assert coverage(_BEDROCK) == (1, "pinned", "no_backup", "pinned", "bedrock")
    assert coverage("retired-name") == (1, "unknown", "unknown", None, None)
    assert coverage("claude-opus-x") == (6, "unknown", "subscription", None, None)

    assert app["model_count"] == 8
    assert app["no_backup_count"] == 4
    assert app["policies"] == [{"name": "paired", "requests": 4}, {"name": "solo", "requests": 3}]


def test_a_catalog_id_counts_only_the_offerings_the_key_may_reach(routing_client: TestClient, world: _World) -> None:
    [narrow] = _read_as(routing_client, world, "member", [world.keys["narrow"]])

    claude = next(model for model in narrow["models"] if model["name"] == _CLAUDE)
    assert (claude["name"], claude["backup"], claude["reason"], claude["provider"]) == (
        _CLAUDE,
        "no_backup",
        "single_offering",
        "anthropic",
    )


def test_a_policy_counts_only_the_candidates_the_key_may_reach(routing_client: TestClient, world: _World) -> None:
    [narrow] = _read_as(routing_client, world, "member", [world.keys["narrow"]])

    # `paired` backs Anthropic with Bedrock, which this key's allow-list refuses,
    # so its compiled plan has the one candidate.
    paired = next(model for model in narrow["models"] if model["name"] == "paired")
    assert (paired["backup"], paired["reason"], paired["provider"]) == (
        "no_backup",
        "single_target_policy",
        "anthropic",
    )


def test_keys_answer_in_the_order_asked_and_an_idle_key_is_empty(routing_client: TestClient, world: _World) -> None:
    asked = [world.keys["idle"], world.keys["narrow"], world.keys["app"], world.keys["narrow"]]
    keys = _read_as(routing_client, world, "member", asked)

    assert [key["api_key_id"] for key in keys] == [world.keys["idle"], world.keys["narrow"], world.keys["app"]]
    assert (keys[0]["models"], keys[0]["model_count"], keys[0]["no_backup_count"], keys[0]["policies"]) == (
        [],
        0,
        0,
        [],
    )


def test_the_read_answers_the_same_from_the_rollups_as_from_the_rows(
    routing_client: TestClient, world: _World, test_config: GatewayConfig
) -> None:
    asked = [world.keys["app"], world.keys["narrow"]]
    from_rows = _read_as(routing_client, world, "member", asked)

    assert refresh_usage_rollups(test_config.database_url) > 0
    assert _read_as(routing_client, world, "member", asked) == from_rows


def test_a_member_never_reads_a_key_that_is_not_theirs(routing_client: TestClient, world: _World) -> None:
    asked = [world.keys["theirs"], world.keys["foreign"], "no-such-key", world.keys["app"]]
    keys = _read_as(routing_client, world, "member", asked)
    assert [key["api_key_id"] for key in keys] == [world.keys["app"]]

    keys = _read_as(routing_client, world, "colleague", [world.keys["app"], world.keys["theirs"]])
    assert [key["api_key_id"] for key in keys] == [world.keys["theirs"]]


def test_the_operator_read_stays_in_the_operators_organization(
    routing_client: TestClient, world: _World, master_key_header: dict[str, str]
) -> None:
    created = routing_client.post(f"{API_ROOT}/keys", headers=master_key_header, json={"key_name": "operator-app"})
    assert created.status_code == status.HTTP_200_OK, created.text

    response = routing_client.get(
        _OPERATOR_PATH,
        params={"api_key_id": [world.keys["app"], created.json()["id"]]},
        headers=master_key_header,
    )
    assert response.status_code == status.HTTP_200_OK, response.text
    # The header master key acts in the deployment's default organization, which alpha is not.
    assert [key["api_key_id"] for key in response.json()["keys"]] == [created.json()["id"]]


def test_a_member_cannot_use_the_operator_read(routing_client: TestClient, world: _World) -> None:
    response = routing_client.get(
        _OPERATOR_PATH,
        params={"api_key_id": [world.keys["app"]]},
        cookies={SESSION_COOKIE_NAME: world.sessions["member"]},
    )
    assert response.status_code == status.HTTP_403_FORBIDDEN


@pytest.mark.parametrize("count", [0, 51])
def test_the_read_takes_between_one_and_fifty_keys(routing_client: TestClient, world: _World, count: int) -> None:
    response = routing_client.get(
        _MEMBER_PATH,
        params={"api_key_id": [f"key-{index}" for index in range(count)]},
        cookies={SESSION_COOKIE_NAME: world.sessions["member"]},
    )
    assert response.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_the_read_needs_a_signed_in_caller(routing_client: TestClient, world: _World) -> None:
    response = routing_client.get(_MEMBER_PATH, params={"api_key_id": [world.keys["app"]]})
    assert response.status_code in (status.HTTP_401_UNAUTHORIZED, status.HTTP_403_FORBIDDEN)
