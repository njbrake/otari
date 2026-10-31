"""A key's backup read follows the organization key's model restriction, as its requests do.

The per-key read in ``test_key_routing.py`` runs on declared providers, which an
organization key never serves. Here no provider is declared, so both offerings
of a catalog ID reach the organization's own keys, and the workspace narrows its
Anthropic key to another model: a request sending the catalog ID then has only
Bedrock to try, and the read has to say so rather than count both.
"""

import uuid
from collections.abc import Callable, Generator, Iterator
from typing import Any

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from gateway.core.config import API_ROOT, GatewayConfig
from gateway.models.tenancy import Organization, Workspace
from gateway.services import catalog as selectors
from gateway.services import selector_index_service
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME
from gateway.services.tenancy import org_provider_key_service as org_store

from .conftest import build_test_client, shared_test_config
from .test_key_routing import _CLAUDE, _IDENTITIES, _NAMES, _ROWS, _identity, _key, _rows

_PATH = f"{API_ROOT}/organizations/me/keys/routing"


@pytest.fixture
def undeclared_client(
    postgres_url: str, clean_database: None, monkeypatch: pytest.MonkeyPatch
) -> Generator[TestClient]:
    """No declared provider, so a bare selector reaches the organization's key; the index is the test's."""

    async def _keep(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(selector_index_service, "rebuild_selector_index", _keep)
    config: GatewayConfig = shared_test_config(postgres_url, {})
    yield from build_test_client(config)


@pytest.fixture
def world(
    undeclared_client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]
) -> dict[str, Any]:
    assert (
        undeclared_client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code
        == status.HTTP_200_OK
    )
    session = db_session_factory()
    try:
        alpha = Organization(name="Alpha", slug="alpha")
        session.add(alpha)
        session.commit()
        alpha_one = Workspace(name="Alpha one", organization_id=alpha.id)
        session.add(alpha_one)
        session.commit()
        member, cookie = _identity(
            session, email="member@alpha.test", organization_id=alpha.id, workspace_ids=(alpha_one.id,)
        )
        app = _key(session, alpha_one.id, member)
        session.add_all(_rows(alpha_one.id, app, _CLAUDE, "anthropic:claude-x-1", count=3))
        session.commit()
        selectors.set_selector_index(selectors.build_selector_index(_ROWS, _IDENTITIES, names=_NAMES))
        return {"workspace": alpha_one.id, "cookie": cookie, "key": app}
    finally:
        session.close()


@pytest.fixture
def organization_keys(world: dict[str, Any]) -> Iterator[tuple[uuid.UUID, str]]:
    """An Anthropic and a Bedrock key for the workspace, each holding a credential, so neither is skipped."""
    keys = [(world["workspace"], "anthropic"), (world["workspace"], "bedrock")]
    for key in keys:
        org_store._org_cache[key] = {"api_key": "test"}
    yield keys[0]
    for key in keys:
        org_store._org_cache.pop(key, None)
        org_store._org_model_restrictions.pop(key, None)


def _claude(client: TestClient, world: dict[str, Any]) -> dict[str, Any]:
    response = client.get(_PATH, params={"api_key_id": [world["key"]]}, cookies={SESSION_COOKIE_NAME: world["cookie"]})
    assert response.status_code == status.HTTP_200_OK, response.text
    [routing] = response.json()["keys"]
    [claude] = routing["models"]
    assert claude["name"] == _CLAUDE
    return dict(claude)


def test_both_offerings_on_the_organizations_keys_are_a_backup(
    undeclared_client: TestClient, world: dict[str, Any], organization_keys: tuple[uuid.UUID, str]
) -> None:
    claude = _claude(undeclared_client, world)
    assert (claude["backup"], claude["reason"]) == ("has_backup", None)


def test_an_offering_the_organization_key_refuses_is_no_backup(
    undeclared_client: TestClient, world: dict[str, Any], organization_keys: tuple[uuid.UUID, str]
) -> None:
    org_store._org_model_restrictions[organization_keys] = ["claude-other"]

    claude = _claude(undeclared_client, world)
    assert (claude["backup"], claude["reason"], claude["provider"]) == (
        "no_backup",
        "single_offering",
        "bedrock",
    )
