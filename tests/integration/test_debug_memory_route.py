"""The memory diagnostics route: absent by default, operator-only when on."""

import tracemalloc
import uuid
from collections.abc import Callable, Generator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from sqlmodel import col

from gateway.core.config import API_ROOT, GatewayConfig
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

from .conftest import build_test_client

_PATH = f"{API_ROOT}/debug/memory"


@pytest.fixture
def diagnostics_client(test_config: GatewayConfig, clean_database: None) -> Generator[TestClient]:
    yield from build_test_client(test_config.model_copy(update={"debug_memory": True}))


@pytest.fixture
def tracing() -> Generator[None]:
    tracemalloc.start()
    yield
    tracemalloc.stop()


def _member_session(session_factory: Callable[[], Session]) -> str:
    """A live dashboard session for an active member who is not an operator."""
    session = session_factory()
    try:
        organization_id: uuid.UUID = session.query(Organization).filter(col(Organization.slug) == "default").one().id
        user = User(email="member@example.com", full_name="Member", active_organization_id=organization_id)
        session.add(user)
        session.commit()
        session.refresh(user)
        session.add(
            OrganizationMember(organization_id=organization_id, user_id=user.id, role="member", status="active")
        )
        token = "otari-sess-member"
        session.add(
            DashboardSession(
                token_hash=hash_session_token(token),
                user_id=user.id,
                created_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=12),
            )
        )
        session.commit()
        return token
    finally:
        session.close()


def test_route_is_a_plain_404_when_the_setting_is_off(client: TestClient, master_key_header: dict[str, str]) -> None:
    assert client.get(_PATH, headers=master_key_header).status_code == 404
    assert client.get(_PATH).status_code == 404


def test_route_requires_a_credential(diagnostics_client: TestClient) -> None:
    assert diagnostics_client.get(_PATH).status_code == 401


def test_route_refuses_a_wrong_master_key(diagnostics_client: TestClient) -> None:
    response = diagnostics_client.get(_PATH, headers={"Otari-Key": "Bearer not-the-master-key"})

    assert response.status_code == 401


def test_route_refuses_a_non_operator_session(
    diagnostics_client: TestClient,
    master_key_header: dict[str, str],
    db_session_factory: Callable[[], Session],
) -> None:
    assert diagnostics_client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == 200
    diagnostics_client.cookies.set(SESSION_COOKIE_NAME, _member_session(db_session_factory))
    try:
        assert diagnostics_client.get(_PATH).status_code == 403
    finally:
        diagnostics_client.cookies.clear()


def test_route_stays_out_of_the_openapi_spec(diagnostics_client: TestClient) -> None:
    spec = diagnostics_client.get(f"{API_ROOT}/openapi.json").json()

    assert _PATH not in spec["paths"]


def test_reading_without_tracing_names_the_environment_variable(
    diagnostics_client: TestClient, master_key_header: dict[str, str]
) -> None:
    response = diagnostics_client.get(_PATH, headers=master_key_header)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "rss_bytes",
        "peak_rss_bytes",
        "mallinfo",
        "allocated_blocks",
        "gc_count",
        "top_types",
        "tracemalloc",
        "tracemalloc_hint",
        "trim",
    }
    assert body["tracemalloc"] is None
    assert "PYTHONTRACEMALLOC" in body["tracemalloc_hint"]
    assert body["trim"] is None
    assert body["allocated_blocks"] > 0
    assert len(body["gc_count"]) == 3
    assert 0 < len(body["top_types"]) <= 25


def test_limit_bounds_every_list(diagnostics_client: TestClient, master_key_header: dict[str, str]) -> None:
    body = diagnostics_client.get(_PATH, params={"limit": 2}, headers=master_key_header).json()

    assert len(body["top_types"]) == 2


@pytest.mark.parametrize("limit", [0, 101])
def test_limit_outside_its_range_is_refused(
    diagnostics_client: TestClient, master_key_header: dict[str, str], limit: int
) -> None:
    assert diagnostics_client.get(_PATH, params={"limit": limit}, headers=master_key_header).status_code == 422


@pytest.mark.usefixtures("tracing")
def test_reading_while_tracing_reports_allocations_and_growth(
    diagnostics_client: TestClient, master_key_header: dict[str, str]
) -> None:
    taken = diagnostics_client.get(_PATH, params={"reset_baseline": True}, headers=master_key_header).json()

    assert taken["tracemalloc_hint"] is None
    assert taken["tracemalloc"]["baseline_taken"] is True
    assert taken["tracemalloc"]["top_growth"] == []

    retained = [bytearray(4096) for _ in range(64)]
    body = diagnostics_client.get(_PATH, params={"limit": 100}, headers=master_key_header).json()
    del retained

    traced = body["tracemalloc"]
    assert traced["baseline_taken"] is False
    assert traced["current_bytes"] > 0
    assert traced["peak_bytes"] >= traced["current_bytes"]
    assert 0 < len(traced["top_allocations"]) <= 100
    assert all(":" in row["location"] and "site-packages" not in row["location"] for row in traced["top_allocations"])
    assert any("test_debug_memory_route.py" in row["location"] for row in traced["top_growth"])
    assert 0 < len(traced["top_files"]) <= 100
    assert all(not row["location"].rpartition(":")[2].isdigit() for row in traced["top_files"])


def test_trim_reports_rss_around_the_call(diagnostics_client: TestClient, master_key_header: dict[str, str]) -> None:
    body = diagnostics_client.get(_PATH, params={"trim": True}, headers=master_key_header).json()

    if body["mallinfo"] is None:
        pytest.skip("not running on glibc")
    assert set(body["trim"]) == {"rss_before_bytes", "rss_after_bytes", "released"}
    assert isinstance(body["trim"]["released"], bool)
