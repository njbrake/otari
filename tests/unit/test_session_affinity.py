"""Forwarding the scoped prompt cache key as Baseten's ``x-session-affinity`` header."""

import json
from collections.abc import AsyncIterator
from typing import Any, cast

import httpx
import pytest
from any_llm import LLMProvider, amessages

from gateway.api.routes._pipeline import RequestContext, _local_attempt_kwargs, scope_prompt_cache_key
from gateway.api.routes._tools import _strip_gateway_fields
from gateway.core.config import GatewayConfig
from gateway.services.provider_kwargs import SESSION_AFFINITY_HEADER, get_provider_kwargs, with_session_affinity
from gateway.types.attempt import Attempt

BASETEN = {
    "provider_type": "openai",
    "api_base": "https://inference.baseten.co/v1",
    "api_key": "test-key",
    "session_affinity": True,
}


def _config(**providers: dict[str, Any]) -> GatewayConfig:
    return GatewayConfig(providers=providers)


def _scoped(caller_key: str, config: GatewayConfig) -> str:
    ctx = RequestContext(
        config=config,
        db=None,
        log_writer=cast(Any, None),
        hybrid_mode=False,
        route=None,
        user_token=None,
        api_key_id=None,
        user_id="user-a",
        rate_limit_info=None,
        reservation=None,
        started_at=0.0,
    )
    fields: dict[str, Any] = {"prompt_cache_key": caller_key}
    scope_prompt_cache_key(fields, ctx)
    scoped = fields["prompt_cache_key"]
    assert isinstance(scoped, str)
    return scoped


def test_header_is_sent_when_the_instance_opts_in_and_a_key_is_present() -> None:
    config = _config(baseten=BASETEN)
    kwargs = with_session_affinity({"prompt_cache_key": "scoped"}, config, "baseten")
    assert kwargs["extra_headers"] == {SESSION_AFFINITY_HEADER: "scoped"}


@pytest.mark.parametrize("flag", [False, None])
def test_header_is_absent_when_the_flag_is_off(flag: bool | None) -> None:
    entry = {k: v for k, v in BASETEN.items() if k != "session_affinity"}
    if flag is not None:
        entry["session_affinity"] = flag
    kwargs = with_session_affinity({"prompt_cache_key": "scoped"}, _config(baseten=entry), "baseten")
    assert "extra_headers" not in kwargs


@pytest.mark.parametrize("fields", [{}, {"prompt_cache_key": ""}, {"prompt_cache_key": None}])
def test_header_is_absent_when_no_key_was_sent(fields: dict[str, Any]) -> None:
    kwargs = with_session_affinity(fields, _config(baseten=BASETEN), "baseten")
    assert "extra_headers" not in kwargs


def test_header_is_absent_for_an_instance_that_is_not_configured() -> None:
    kwargs = with_session_affinity({"prompt_cache_key": "scoped"}, _config(baseten=BASETEN), "openai")
    assert "extra_headers" not in kwargs


def test_the_value_sent_is_the_scoped_key_never_the_raw_one() -> None:
    config = _config(baseten=BASETEN)
    scoped = _scoped("clawbolt-session-42", config)

    kwargs = with_session_affinity({"prompt_cache_key": scoped}, config, "baseten")

    assert kwargs["extra_headers"][SESSION_AFFINITY_HEADER] == scoped
    assert scoped != "clawbolt-session-42"
    assert len(scoped) == 64


def test_other_extra_headers_are_kept() -> None:
    kwargs = with_session_affinity(
        {"prompt_cache_key": "scoped", "extra_headers": {"x-other": "1"}}, _config(baseten=BASETEN), "baseten"
    )
    assert kwargs["extra_headers"] == {"x-other": "1", SESSION_AFFINITY_HEADER: "scoped"}


def test_the_flag_never_reaches_the_provider_call() -> None:
    kwargs = get_provider_kwargs(_config(baseten=BASETEN), LLMProvider.OPENAI, instance="baseten")
    assert "session_affinity" not in kwargs
    assert kwargs["api_base"] == BASETEN["api_base"]


def test_a_non_boolean_flag_is_rejected_at_config_load() -> None:
    config = _config(baseten={**BASETEN, "session_affinity": "yes"})
    with pytest.raises(ValueError, match="session_affinity must be true or false"):
        config.validate_provider_instances()
    _config(baseten=BASETEN).validate_provider_instances()  # no raise


def test_a_caller_cannot_send_its_own_upstream_headers() -> None:
    fields = _strip_gateway_fields({"model": "baseten:glm", "extra_headers": {SESSION_AFFINITY_HEADER: "raw"}})
    assert "extra_headers" not in fields


class _Adapter:
    def local_attempt_kwargs(self, attempt: Attempt, base_request_fields: dict[str, Any]) -> dict[str, Any]:
        return attempt.call_kwargs(base_request_fields)


def test_each_routed_candidate_uses_its_own_instance_setting() -> None:
    config = _config(baseten=BASETEN, fallback={"provider_type": "openai", "api_key": "k"})
    build = _local_attempt_kwargs(cast(Any, _Adapter()), config)
    fields = {"prompt_cache_key": "scoped"}

    baseten = Attempt(position=1, instance="baseten", provider=LLMProvider.OPENAI, model="glm")
    fallback = Attempt(position=2, instance="fallback", provider=LLMProvider.OPENAI, model="gpt")

    assert build(baseten, fields)["extra_headers"] == {SESSION_AFFINITY_HEADER: "scoped"}
    assert "extra_headers" not in build(fallback, fields)


def _completion(stream: bool) -> httpx.Response:
    if not stream:
        return httpx.Response(
            200,
            json={
                "id": "c1",
                "object": "chat.completion",
                "created": 0,
                "model": "glm",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
            },
        )
    chunks: list[dict[str, Any]] = [
        {"choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}]},
        {
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
        },
    ]
    base = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "glm"}
    body = "".join(f"data: {json.dumps({**base, **c})}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, text=body, headers={"content-type": "text/event-stream"})


@pytest.mark.asyncio
@pytest.mark.parametrize("stream", [False, True])
async def test_header_reaches_the_wire_on_a_translated_messages_call(stream: bool) -> None:
    """any-llm carries ``extra_headers`` through its Messages-to-Completions bridge.

    Pins the contract this feature relies on: an any-llm upgrade that drops
    per-request kwargs on the bridged path fails here rather than silently.
    """
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return _completion(stream)

    result = await amessages(
        model="openai:glm",
        api_key="test-key",
        api_base="https://inference.baseten.co/v1",
        client_args={"http_client": httpx.AsyncClient(transport=httpx.MockTransport(handler))},
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=16,
        stream=stream,
        extra_headers={SESSION_AFFINITY_HEADER: "scoped"},
    )
    if stream:
        async for _ in cast(AsyncIterator[Any], result):
            pass

    assert len(seen) == 1
    assert seen[0].url.path == "/v1/chat/completions"
    assert seen[0].headers[SESSION_AFFINITY_HEADER] == "scoped"
