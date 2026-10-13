"""The heavy usage reads behind the worker's gate, as a caller sees them."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from gateway.core.config import API_ROOT
from gateway.services.usage import _service

WINDOW = {"start_date": "2026-10-01T00:00:00Z", "end_date": "2026-10-02T00:00:00Z"}


@pytest.fixture
def short_wait(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_service, "HEAVY_READ_WAIT_S", 0.05)


@pytest.mark.parametrize(
    "path",
    [
        f"{API_ROOT}/usage/summary",
        f"{API_ROOT}/usage/latency",
        f"{API_ROOT}/usage/tools",
        f"{API_ROOT}/overview",
    ],
)
def test_a_read_that_waits_too_long_for_a_turn_is_told_to_come_back(
    client: TestClient, master_key_header: dict[str, str], short_wait: None, path: str
) -> None:
    # Every turn taken, as when the worker is already running its limit.
    client.app.state.heavy_usage_reads = asyncio.Semaphore(0)  # type: ignore[attr-defined]

    response = client.get(path, params=WINDOW, headers=master_key_header)

    assert response.status_code == 503, response.text
    assert response.json() == {"detail": "Usage reads are busy; try again shortly"}


def test_a_read_gives_its_turn_back(client: TestClient, master_key_header: dict[str, str], short_wait: None) -> None:
    client.app.state.heavy_usage_reads = asyncio.Semaphore(1)  # type: ignore[attr-defined]

    for path in ("summary", "latency", "tools", "summary"):
        response = client.get(f"{API_ROOT}/usage/{path}", params=WINDOW, headers=master_key_header)
        assert response.status_code == 200, response.text
