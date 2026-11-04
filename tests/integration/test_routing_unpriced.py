"""``GET /api/v1/organizations/me/routing-policies/unpriced``: which pool models a Smart router could not price.

One organization with a member in one workspace, a second organization, and a
config pricing one of two OpenAI models. The answer must match what the write
refuses, and a workspace outside the caller's reach answers as one that does
not exist.
"""

import uuid
from collections.abc import Callable, Generator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from gateway.core.config import API_ROOT
from gateway.core.settings.pricing import PricingConfig
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User, Workspace, WorkspaceMember
from gateway.models.users import User as BillingUser
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

from .conftest import build_test_client, declared_test_providers, shared_test_config

_PATH = f"{API_ROOT}/organizations/me/routing-policies/unpriced"
_PRICED = "openai:gpt-5"
_UNPRICED = "openai:gpt-5-unpriced"


@pytest.fixture
def pricing_client(postgres_url: str, clean_database: None) -> Generator[TestClient]:
    """A client whose config prices one OpenAI model and not the other."""
    config = shared_test_config(postgres_url, declared_test_providers()).model_copy(
        update={
            "pricing": {_PRICED: PricingConfig(input_price_per_million=2.5, output_price_per_million=10.0)},
        }
    )
    yield from build_test_client(config)


def _member(session: Session, *, email: str, organization_id: uuid.UUID, workspace_id: uuid.UUID | None) -> str:
    """A member with a live dashboard session; their cookie."""
    user = User(email=email, full_name=email.split("@")[0].title(), active_organization_id=organization_id)
    session.add(user)
    session.commit()
    session.refresh(user)
    session.add(OrganizationMember(organization_id=organization_id, user_id=user.id, role="member", status="active"))
    if workspace_id is not None:
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
    return token


@pytest.fixture
def world(
    pricing_client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]
) -> dict[str, str]:
    assert (
        pricing_client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK
    )
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
        return {
            "member": _member(session, email="member@alpha.test", organization_id=alpha.id, workspace_id=alpha_one.id),
            "alpha_one": str(alpha_one.id),
            "alpha_two": str(alpha_two.id),
            "beta_one": str(beta_one.id),
        }
    finally:
        session.close()


def _ask(client: TestClient, world: dict[str, str], workspace: str, selectors: list[str]) -> tuple[int, Any]:
    response = client.get(
        _PATH,
        params={"workspace_id": world[workspace], "selector": selectors},
        cookies={SESSION_COOKIE_NAME: world["member"]},
    )
    return response.status_code, response.json()


def test_a_member_learns_which_pool_models_have_no_price(pricing_client: TestClient, world: dict[str, str]) -> None:
    code, body = _ask(pricing_client, world, "alpha_one", [_UNPRICED, _PRICED])
    assert code == status.HTTP_200_OK, body
    assert body == {"unpriced": [_UNPRICED]}

    code, body = _ask(pricing_client, world, "alpha_one", [_PRICED])
    assert (code, body) == (status.HTTP_200_OK, {"unpriced": []})


@pytest.mark.parametrize("workspace", ["alpha_two", "beta_one"])
def test_a_workspace_the_member_cannot_see_is_not_found(
    pricing_client: TestClient, world: dict[str, str], workspace: str
) -> None:
    code, _ = _ask(pricing_client, world, workspace, [_UNPRICED])
    assert code == status.HTTP_404_NOT_FOUND


def test_the_question_is_bounded_by_a_policys_cap_on_models(pricing_client: TestClient, world: dict[str, str]) -> None:
    code, _ = _ask(pricing_client, world, "alpha_one", [f"openai:m-{index}" for index in range(6)])
    assert code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_the_read_needs_a_signed_in_caller(pricing_client: TestClient, world: dict[str, str]) -> None:
    response = pricing_client.get(_PATH, params={"workspace_id": world["alpha_one"], "selector": [_PRICED]})
    assert response.status_code == status.HTTP_401_UNAUTHORIZED
