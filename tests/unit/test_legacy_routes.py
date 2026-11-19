"""Pre-0.6 request paths served on the routes that replaced them (sqlite-backed TestClient)."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from gateway.core.config import API_ROOT, OTLP_ROOT, GatewayConfig
from gateway.legacy_routes import LegacyRouteMiddleware, legacy_prefix
from gateway.main import create_app

MASTER_KEY = "sk-test-master"
AUTH = {"Authorization": f"Bearer {MASTER_KEY}"}


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/v1/chat/completions", f"{API_ROOT}/chat/completions"),
        ("/v1/messages", f"{API_ROOT}/messages"),
        ("/v1/models", f"{API_ROOT}/models"),
        ("/v1", API_ROOT),
        ("/health", f"{API_ROOT}/health"),
        ("/health/readiness", f"{API_ROOT}/health/readiness"),
        ("/v1/traces", f"{OTLP_ROOT}/v1/traces"),
        ("/v1/logs", f"{OTLP_ROOT}/v1/logs"),
        ("/v1/metrics", f"{OTLP_ROOT}/v1/metrics"),
    ],
)
def test_legacy_path_moves_onto_its_current_route(path: str, expected: str) -> None:
    assert legacy_prefix(path) + path == expected


@pytest.mark.parametrize(
    "path",
    [
        "/",
        f"{API_ROOT}/chat/completions",
        f"{API_ROOT}/health",
        f"{OTLP_ROOT}/v1/traces",
        "/v10/models",
        "/healthz",
        "/metrics",
        "/welcome",
    ],
)
def test_current_paths_are_left_alone(path: str) -> None:
    assert legacy_prefix(path) == ""


@pytest.mark.asyncio
async def test_middleware_prefixes_path_and_raw_path() -> None:
    seen: dict[str, Any] = {}

    async def app(scope: Any, receive: Any, send: Any) -> None:
        seen.update(scope)

    scope = {"type": "http", "path": "/v1/files/a b", "raw_path": b"/v1/files/a%20b"}
    await LegacyRouteMiddleware(app)(scope, None, None)  # type: ignore[arg-type]

    assert seen["path"] == f"{API_ROOT}/files/a b"
    assert seen["raw_path"] == f"{API_ROOT}/files/a%20b".encode()
    assert scope["path"] == "/v1/files/a b", "the caller's scope is not mutated"


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    config = GatewayConfig(
        database_url=f"sqlite:///{tmp_path / 'legacy-routes-test.db'}",
        master_key=MASTER_KEY,
        require_pricing=False,
    )
    with TestClient(create_app(config)) as test_client:
        yield test_client


def test_legacy_health_probes_are_served(client: TestClient) -> None:
    assert client.get("/health").status_code == 200
    assert client.get("/health/readiness").json() == client.get(f"{API_ROOT}/health/readiness").json()


def test_legacy_management_route_keeps_its_auth(client: TestClient) -> None:
    assert client.get("/v1/keys").status_code == 401
    assert client.get("/v1/keys", headers=AUTH).status_code == 200


@pytest.mark.parametrize("resource", ["chat/completions", "messages", "responses"])
def test_legacy_inference_routes_reach_their_handlers(client: TestClient, resource: str) -> None:
    legacy = client.post(f"/v1/{resource}", json={})
    current = client.post(f"{API_ROOT}/{resource}", json={})
    assert legacy.status_code != 404
    assert (legacy.status_code, legacy.json()) == (current.status_code, current.json())


def test_legacy_otlp_ingest_reaches_the_otlp_root(client: TestClient) -> None:
    legacy = client.post("/v1/traces", content=b"", headers={"Content-Type": "application/x-protobuf"})
    current = client.post(f"{OTLP_ROOT}/v1/traces", content=b"", headers={"Content-Type": "application/x-protobuf"})
    assert legacy.status_code != 404
    assert legacy.status_code == current.status_code
