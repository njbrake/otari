"""``otari_gateway_origin``: an ``otari`` api_base written for any-llm 1.27 keeps working on 1.29."""

import pytest
from any_llm import LLMProvider

from gateway.core.config import GatewayConfig
from gateway.services.provider_kwargs import get_provider_kwargs, otari_gateway_origin


@pytest.mark.parametrize(
    "api_base",
    ["https://api.otari.ai/api/v1", "https://api.otari.ai/api/v1/", "https://api.otari.ai/v1", "https://api.otari.ai"],
)
def test_prefix_is_removed(api_base: str) -> None:
    assert otari_gateway_origin(api_base) == "https://api.otari.ai"


def test_other_paths_are_left_alone() -> None:
    assert otari_gateway_origin("https://gw.example/team") == "https://gw.example/team"
    assert otari_gateway_origin(None) is None


def test_only_the_otari_provider_is_rewritten() -> None:
    config = GatewayConfig(
        providers={
            "otari.ai": {"provider_type": "otari", "api_base": "https://api.otari.ai/api/v1", "api_key": "k"},
            "vllm": {"api_base": "http://box:8000/v1", "api_key": "k"},
        }
    )
    assert get_provider_kwargs(config, LLMProvider.OTARI, "otari.ai")["api_base"] == "https://api.otari.ai"
    assert get_provider_kwargs(config, LLMProvider.VLLM, "vllm")["api_base"] == "http://box:8000/v1"
