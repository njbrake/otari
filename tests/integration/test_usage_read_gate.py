"""The heavy usage reads behind the worker's gate, as a caller sees them."""

from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from gateway.core.config import API_ROOT
from gateway.services.usage_and_telemetry import HeavyUsageReads

WINDOW = {"start_date": "2026-10-01T00:00:00Z", "end_date": "2026-10-02T00:00:00Z"}

HEAVY_READS = [
    f"{API_ROOT}/{base}/{read}"
    for base in ("usage", "organizations/me/usage")
    for read in ("summary", "series", "count")
]


def _params(path: str) -> dict[str, str]:
    return {**WINDOW, "group_by": "model"} if path.endswith("/series") else WINDOW


def _state(client: TestClient) -> Any:
    return cast(FastAPI, client.app).state


@pytest.mark.parametrize("path", HEAVY_READS)
def test_a_read_that_waits_too_long_for_a_turn_is_told_to_come_back(
    client: TestClient, master_key_header: dict[str, str], path: str
) -> None:
    # Every turn taken, as when the worker is already running its limit.
    _state(client).heavy_usage_reads = HeavyUsageReads(0, wait_s=0.05)

    response = client.get(path, params=_params(path), headers=master_key_header)

    assert response.status_code == 503, response.text
    assert response.json() == {"detail": "Usage reads are busy; try again shortly"}


def test_a_cheap_read_does_not_wait_for_a_turn(client: TestClient, master_key_header: dict[str, str]) -> None:
    _state(client).heavy_usage_reads = HeavyUsageReads(0, wait_s=0.05)

    response = client.get(f"{API_ROOT}/usage", params=WINDOW, headers=master_key_header)

    assert response.status_code == 200, response.text


def test_a_read_gives_its_turn_back(client: TestClient, master_key_header: dict[str, str]) -> None:
    _state(client).heavy_usage_reads = HeavyUsageReads(1, wait_s=0.05)

    for path in (*HEAVY_READS, HEAVY_READS[0]):
        response = client.get(path, params=_params(path), headers=master_key_header)
        assert response.status_code == 200, response.text


def test_the_lifespan_sizes_the_gate_from_the_setting(client: TestClient) -> None:
    gate = _state(client).heavy_usage_reads

    assert isinstance(gate, HeavyUsageReads)
    assert gate.limit == _state(client).config.usage_read_concurrency
