"""A model otari.ai serves lists its limits: from otari.ai's own listing, else from its vendor's models.dev entry.

otari.ai is a hosted provider of implementation ``otari`` named ``otari-ai``,
whose ids are ``vendor/model``. models.dev has no ``otari`` provider, so
without either source the model would list no limits at all. The provider
listing is stubbed and models.dev is served from a fixture.
"""

from collections.abc import Generator, Iterator
from typing import Any
from unittest.mock import patch

import pytest
from any_llm.types.model import Model
from fastapi.testclient import TestClient

from gateway.core.config import API_ROOT, GatewayConfig
from gateway.services import model_catalog_service as mcs
from gateway.services.model_discovery_service import ProviderDiscovery, get_model_cache
from gateway.services.secret_box import generate_secret_key
from gateway.types.models_dev import parse_catalog

from .conftest import build_test_client, shared_test_config

MODEL = "openai/gpt-4o-mini"
OTARI = {"provider": "otari", "api_key": "sk-otari", "api_base": "https://api.otari.example"}
CATALOG = parse_catalog(
    {
        "openai": {
            "models": {
                "gpt-4o-mini": {
                    "name": "GPT-4o mini",
                    "tool_call": True,
                    "modalities": {"input": ["text", "image"], "output": ["text"]},
                    "limit": {"context": 128000, "output": 16384},
                },
            },
        },
    }
)


@pytest.fixture(scope="module")
def test_config(postgres_url: str) -> GatewayConfig:
    return shared_test_config(postgres_url, {}).model_copy(update={"hosted_providers": {"otari-ai": OTARI}})


@pytest.fixture(autouse=True)
def _secret_key(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("OTARI_SECRET_KEY", generate_secret_key())
    get_model_cache().clear()
    yield
    get_model_cache().clear()


def _serve_listing(monkeypatch: pytest.MonkeyPatch, **limits: Any) -> None:
    """otari.ai lists one priced model, with ``limits`` beside it."""
    pricing = {"input_price_per_million": 0.15, "output_price_per_million": 0.6}

    async def _stub(impl_name: str, **_: object) -> ProviderDiscovery:
        model = Model.model_validate(
            {"id": MODEL, "object": "model", "created": 0, "owned_by": "openai", "pricing": pricing, **limits}
        )
        return ProviderDiscovery(provider=impl_name, models=[model])

    monkeypatch.setattr("gateway.services.providers._hosted_provider_service.test_provider_credentials", _stub)


@pytest.fixture
def client(test_config: GatewayConfig, clean_database: None) -> Generator[TestClient]:
    mcs.clear_catalog_cache()
    try:
        yield from build_test_client(test_config)
    finally:
        mcs.clear_catalog_cache()


def _listed(client: TestClient, headers: dict[str, str]) -> dict[str, Any]:
    """Switch otari.ai's model on, dial it as discovery does, and return its ``/v1/models`` entry."""
    assert client.post(f"{API_ROOT}/hosted-providers/otari-ai/models/refresh", headers=headers).status_code == 200
    dialed = client.get(f"{API_ROOT}/models/discoverable", params={"refresh": True}, headers=headers)
    assert dialed.status_code == 200, dialed.text
    with patch.object(mcs, "_fallback", return_value=CATALOG):
        response = client.get(f"{API_ROOT}/models/otari-ai:{MODEL}", headers=headers)
    assert response.status_code == 200, response.text
    listed: dict[str, Any] = response.json()
    return listed


def test_otari_ai_s_own_limits_are_listed(
    client: TestClient, master_key_header: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve_listing(monkeypatch, context_window=64000, max_output_tokens=32000)

    model = _listed(client, master_key_header)

    # The listing's window, and its output limit over models.dev's.
    assert (model["context_window"], model["max_output_tokens"]) == (64000, 32000)
    assert model["name"] == "GPT-4o mini"


def test_a_listing_without_limits_takes_them_from_the_vendor_s_entry(
    client: TestClient, master_key_header: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    _serve_listing(monkeypatch)

    model = _listed(client, master_key_header)

    assert (model["context_window"], model["max_output_tokens"]) == (128000, 16384)
    assert model["supported_parameters"] == ["tools", "tool_choice"]
    assert model["architecture"]["input_modalities"] == ["text", "image"]
