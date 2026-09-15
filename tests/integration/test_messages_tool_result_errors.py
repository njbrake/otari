"""A tool result's ``is_error`` reaches a bridged provider as text and a native one as the flag.

any-llm copies the flag onto the OpenAI ``role: tool`` message it builds for a
provider with no native Messages API, and a strict backend refuses the request
for it (see ``gateway.services.tool_result_errors``). Asserted at the
``amessages`` boundary, which is where the request leaves otari.
"""

from collections.abc import Generator
from typing import Any
from unittest.mock import patch

import pytest
from any_llm.types.messages import MessageResponse, MessageUsage, TextBlock
from fastapi.testclient import TestClient

from gateway.core.config import API_KEY_HEADER, API_ROOT, GatewayConfig

from .conftest import build_test_client

HEADERS = {API_KEY_HEADER: "Bearer test-master-key"}


@pytest.fixture
def client(postgres_url: str) -> Generator[TestClient]:
    config = GatewayConfig(
        database_url=postgres_url,
        master_key="test-master-key",
        host="127.0.0.1",
        port=8000,
        auto_migrate=False,
        require_pricing=False,
        model_discovery=False,
        providers={
            "anthropic": {"api_key": "sk-ant"},
            "home_lab": {"provider_type": "openai", "api_base": "https://box.ts.net/v1", "api_key": "home-lab-token"},
        },
    )
    yield from build_test_client(config)


def _response() -> MessageResponse:
    return MessageResponse(
        id="msg_1",
        type="message",
        role="assistant",
        model="m",
        content=[TextBlock(type="text", text="understood", citations=None)],
        stop_reason=None,
        stop_sequence=None,
        usage=MessageUsage(
            input_tokens=10,
            output_tokens=2,
            cache_creation_input_tokens=None,
            cache_read_input_tokens=None,
            cache_creation=None,
            server_tool_use=None,
            service_tier=None,
        ),
        container=None,
    )


def _sent_tool_result(client: TestClient, model: str) -> dict[str, Any]:
    """Post a turn whose last tool result failed, and return that result as it left for the provider."""
    created = client.post(f"{API_ROOT}/users", json={"user_id": "test-user"}, headers=HEADERS)
    assert created.status_code == 200, created.text
    captured: dict[str, Any] = {}

    async def mock_amessages(**kwargs: Any) -> MessageResponse:
        captured.update(kwargs)
        return _response()

    with patch("gateway.api.routes.messages.amessages", new=mock_amessages):
        resp = client.post(
            f"{API_ROOT}/messages",
            json={
                "model": model,
                "max_tokens": 16,
                "metadata": {"user_id": "test-user"},
                "messages": [
                    {"role": "user", "content": "push the branch"},
                    {
                        "role": "assistant",
                        "content": [{"type": "tool_use", "id": "toolu_1", "name": "push", "input": {}}],
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "toolu_1",
                                "content": "blocked by referee",
                                "is_error": True,
                            }
                        ],
                    },
                ],
            },
            headers=HEADERS,
        )
    assert resp.status_code == 200, resp.text
    result: dict[str, Any] = captured["messages"][-1]["content"][0]
    return result


def test_a_bridged_provider_receives_the_error_as_text(client: TestClient) -> None:
    sent = _sent_tool_result(client, "home_lab:qwen3")

    assert "is_error" not in sent
    assert sent["content"] == "Error: blocked by referee"


def test_a_native_messages_provider_receives_the_flag(client: TestClient) -> None:
    sent = _sent_tool_result(client, "anthropic:claude-opus-4")

    assert sent["is_error"] is True
    assert sent["content"] == "blocked by referee"
