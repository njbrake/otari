"""``x-session-affinity`` on the completion routes, chiefly /api/v1/messages to a translated OpenAI-type instance."""

from collections.abc import AsyncIterator, Generator
from typing import Any, cast
from unittest.mock import patch

import httpx
import pytest
from any_llm import aresponses as real_aresponses
from any_llm.types.messages import (
    MessageDelta,
    MessageDeltaEvent,
    MessageDeltaUsage,
    MessageResponse,
    MessageStartEvent,
    MessageStopEvent,
    MessageStreamEvent,
    MessageUsage,
    TextBlock,
)
from fastapi.testclient import TestClient

from gateway.core.config import API_KEY_HEADER, API_ROOT, GatewayConfig
from gateway.services.provider_kwargs import SESSION_AFFINITY_HEADER

from .conftest import build_test_client

_BASETEN = {"provider_type": "openai", "api_base": "https://inference.baseten.co/v1", "api_key": "test-key"}


@pytest.fixture
def affinity_client(postgres_url: str) -> Generator[TestClient]:
    config = GatewayConfig(
        database_url=postgres_url,
        master_key="test-master-key",
        host="127.0.0.1",
        port=8000,
        auto_migrate=False,
        require_pricing=False,
        providers={"baseten": {**_BASETEN, "session_affinity": True}, "plain": _BASETEN},
    )
    yield from build_test_client(config)


@pytest.fixture
def key_header(affinity_client: TestClient) -> dict[str, str]:
    response = affinity_client.post(
        f"{API_ROOT}/keys", json={"key_name": "affinity"}, headers={API_KEY_HEADER: "Bearer test-master-key"}
    )
    assert response.status_code == 200, response.text
    return {API_KEY_HEADER: f"Bearer {response.json()['key']}"}


def _message() -> MessageResponse:
    return MessageResponse(
        id="msg_1",
        type="message",
        role="assistant",
        content=[TextBlock(type="text", text="ok")],
        model="glm",
        stop_reason="end_turn",
        usage=MessageUsage(input_tokens=3, output_tokens=1),
    )


async def _events() -> AsyncIterator[MessageStreamEvent]:
    yield MessageStartEvent.model_validate({"type": "message_start", "message": _message().model_dump()})
    yield MessageDeltaEvent(
        type="message_delta",
        delta=MessageDelta(stop_reason="end_turn"),
        usage=MessageDeltaUsage(output_tokens=1, input_tokens=3),
    )
    yield MessageStopEvent(type="message_stop")


def _send(client: TestClient, headers: dict[str, str], model: str, **extra: Any) -> dict[str, Any]:
    """POST /messages with the provider call captured, returning the kwargs it was given."""
    captured: dict[str, Any] = {}
    stream = bool(extra.get("stream"))

    async def fake_amessages(**kwargs: Any) -> Any:
        captured.update(kwargs)
        return _events() if stream else _message()

    body = {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 16, **extra}
    with patch("gateway.api.routes.messages.amessages", new=fake_amessages):
        response = client.post(f"{API_ROOT}/messages", json=body, headers=headers)
        if stream:
            _ = response.text  # drain the stream so the provider call has run
    assert response.status_code == 200, response.text
    return captured


@pytest.mark.parametrize("stream", [False, True])
def test_opted_in_instance_gets_the_scoped_key_as_the_header(
    affinity_client: TestClient, key_header: dict[str, str], stream: bool
) -> None:
    captured = _send(affinity_client, key_header, "baseten:zai-org/GLM-5.3", prompt_cache_key="s-42", stream=stream)

    scoped = captured["prompt_cache_key"]
    assert scoped != "s-42"
    assert len(scoped) == 64
    assert captured["client_args"]["default_headers"] == {SESSION_AFFINITY_HEADER: scoped}


@pytest.mark.parametrize("stream", [False, True])
def test_no_header_for_an_instance_that_did_not_opt_in(
    affinity_client: TestClient, key_header: dict[str, str], stream: bool
) -> None:
    captured = _send(affinity_client, key_header, "plain:zai-org/GLM-5.3", prompt_cache_key="s-42", stream=stream)
    assert "client_args" not in captured


@pytest.mark.parametrize("stream", [False, True])
def test_no_header_when_no_key_was_sent(affinity_client: TestClient, key_header: dict[str, str], stream: bool) -> None:
    captured = _send(affinity_client, key_header, "baseten:zai-org/GLM-5.3", stream=stream)
    assert "prompt_cache_key" not in captured
    assert "client_args" not in captured


class _FakeResponse:
    usage = None

    def model_dump(self, *, exclude_none: bool = False) -> dict[str, Any]:
        return {"id": "resp_1", "output": []}


def _send_responses(client: TestClient, headers: dict[str, str], model: str, **extra: Any) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    async def fake_aresponses(**kwargs: Any) -> _FakeResponse:
        captured.update(kwargs)
        return _FakeResponse()

    with patch("gateway.api.routes.responses.aresponses", new=fake_aresponses):
        response = client.post(f"{API_ROOT}/responses", json={"model": model, "input": "hi", **extra}, headers=headers)
    assert response.status_code == 200, response.text
    return captured


def test_responses_route_sends_the_header_too(affinity_client: TestClient, key_header: dict[str, str]) -> None:
    captured = _send_responses(affinity_client, key_header, "baseten:zai-org/GLM-5.3", prompt_cache_key="s-42")
    assert captured["client_args"]["default_headers"] == {SESSION_AFFINITY_HEADER: captured["prompt_cache_key"]}


def test_responses_route_sends_the_header_on_the_wire(affinity_client: TestClient, key_header: dict[str, str]) -> None:
    """Through the real ``aresponses``, which rejects kwargs it does not declare, ``extra_headers`` among them."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            json={
                "id": "resp_1",
                "object": "response",
                "created_at": 0,
                "model": "glm",
                "output": [],
                "status": "completed",
                "parallel_tool_calls": True,
                "tool_choice": "auto",
                "tools": [],
            },
        )

    async def wired_aresponses(**kwargs: Any) -> Any:
        client_args = {
            **kwargs.get("client_args", {}),
            "http_client": httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        }
        return await real_aresponses(**{**kwargs, "client_args": client_args})

    body = {"model": "baseten:zai-org/GLM-5.3", "input": "hi", "prompt_cache_key": "s-42"}
    with patch("gateway.api.routes.responses.aresponses", new=wired_aresponses):
        response = affinity_client.post(f"{API_ROOT}/responses", json=body, headers=key_header)

    assert response.status_code == 200, response.text
    assert len(seen) == 1
    sent = seen[0].headers[SESSION_AFFINITY_HEADER]
    assert sent != "s-42"
    assert len(sent) == 64


@pytest.mark.parametrize("model", ["plain:zai-org/GLM-5.3", "baseten:zai-org/GLM-5.3"])
def test_a_caller_cannot_set_the_header_itself(
    affinity_client: TestClient, key_header: dict[str, str], model: str
) -> None:
    """The Responses body allows extra fields, so a caller's ``extra_headers`` is stripped, not forwarded."""
    captured = _send_responses(
        affinity_client,
        key_header,
        model,
        prompt_cache_key="s-42",
        extra_headers={SESSION_AFFINITY_HEADER: "raw-caller-value", "x-other": "1"},
    )
    assert "extra_headers" not in captured
    sent = (captured.get("client_args") or {}).get("default_headers") or {}
    assert "raw-caller-value" not in sent.values()
    assert "x-other" not in sent


def test_the_flag_is_not_passed_to_the_provider(affinity_client: TestClient, key_header: dict[str, str]) -> None:
    captured = _send(affinity_client, key_header, "baseten:zai-org/GLM-5.3", prompt_cache_key="s-42")
    assert "session_affinity" not in captured
    assert cast(str, captured["api_base"]) == _BASETEN["api_base"]


def test_a_provider_stored_through_the_dashboard_sends_the_header(
    client: TestClient, master_key_header: dict[str, str], api_key_header: dict[str, str]
) -> None:
    """The flag set on a stored provider reaches dispatch through the provider overlay."""
    created = client.post(
        f"{API_ROOT}/provider-credentials",
        json={
            "instance": "stored-baseten",
            "provider_type": "openai-compatible",
            "api_base": "https://inference.baseten.co/v1",
            "session_affinity": True,
        },
        headers=master_key_header,
    )
    assert created.status_code == 201, created.text

    captured = _send(client, api_key_header, "stored-baseten:zai-org/GLM-5.3", prompt_cache_key="s-42")

    scoped = captured["prompt_cache_key"]
    assert len(scoped) == 64
    assert captured["client_args"]["default_headers"] == {SESSION_AFFINITY_HEADER: scoped}
