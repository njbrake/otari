"""A tool result's ``is_error`` reaches a bridged provider as text and a native one as the flag.

For a provider with no native Messages API, any-llm builds an OpenAI ``role: tool``
message, and a strict backend refuses one carrying ``is_error``. Asserted below
``amessages``, at the provider call, so the conversion any-llm owns is exercised.
"""

from collections.abc import Generator
from typing import Any
from unittest.mock import patch

import pytest
from any_llm.providers.anthropic.anthropic import AnthropicProvider
from any_llm.providers.openai.openai import OpenaiProvider
from any_llm.types.completion import ChatCompletion, CompletionParams
from any_llm.types.messages import MessageResponse, MessagesParams, MessageUsage, TextBlock
from fastapi.testclient import TestClient

from gateway.core.config import API_KEY_HEADER, API_ROOT, GatewayConfig

from .conftest import build_test_client

HEADERS = {API_KEY_HEADER: "Bearer test-master-key"}

MESSAGES = [
    {"role": "user", "content": "push the branch"},
    {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "push", "input": {}}]},
    {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "toolu_1", "content": "blocked by referee", "is_error": True}
        ],
    },
]


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


def _post(client: TestClient, model: str) -> None:
    created = client.post(f"{API_ROOT}/users", json={"user_id": "test-user"}, headers=HEADERS)
    assert created.status_code == 200, created.text
    resp = client.post(
        f"{API_ROOT}/messages",
        json={"model": model, "max_tokens": 16, "metadata": {"user_id": "test-user"}, "messages": MESSAGES},
        headers=HEADERS,
    )
    assert resp.status_code == 200, resp.text


def test_a_bridged_provider_receives_the_error_as_text(client: TestClient) -> None:
    captured: list[CompletionParams] = []

    async def fake_acompletion(self: OpenaiProvider, params: CompletionParams, **kwargs: Any) -> ChatCompletion:
        captured.append(params)
        return ChatCompletion.model_validate(
            {
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 0,
                "model": "qwen3",
                "choices": [
                    {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "understood"}}
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12},
            }
        )

    with patch.object(OpenaiProvider, "_acompletion", fake_acompletion):
        _post(client, "home_lab:qwen3")

    tool_messages = [m for m in captured[0].messages if isinstance(m, dict) and m.get("role") == "tool"]
    assert tool_messages == [{"role": "tool", "tool_call_id": "toolu_1", "content": "Error: blocked by referee"}]


def test_a_native_messages_provider_receives_the_flag(client: TestClient) -> None:
    captured: list[MessagesParams] = []

    async def fake_amessages(self: AnthropicProvider, params: MessagesParams, **kwargs: Any) -> MessageResponse:
        captured.append(params)
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

    with patch.object(AnthropicProvider, "_amessages", fake_amessages):
        _post(client, "anthropic:claude-opus-4")

    sent = captured[0].messages[-1]["content"][0]
    assert sent["is_error"] is True
    assert sent["content"] == "blocked by referee"
