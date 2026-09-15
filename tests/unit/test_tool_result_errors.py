"""``fold_tool_result_errors``: the stopgap for any-llm forwarding ``is_error`` to OpenAI-shaped backends."""

from typing import Any

from gateway.services.tool_result_errors import ERROR_PREFIX, fold_tool_result_errors

BRIDGED = "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731"
NATIVE = "anthropic:claude-opus-4"


def _kwargs(model: str, content: Any, *, is_error: bool | None = True) -> dict[str, Any]:
    result: dict[str, Any] = {"type": "tool_result", "tool_use_id": "toolu_1", "content": content}
    if is_error is not None:
        result["is_error"] = is_error
    return {
        "model": model,
        "max_tokens": 16,
        "messages": [
            {"role": "user", "content": "push the branch"},
            {"role": "assistant", "content": [{"type": "tool_use", "id": "toolu_1", "name": "push", "input": {}}]},
            {"role": "user", "content": [result]},
        ],
    }


def _tool_result(kwargs: dict[str, Any]) -> dict[str, Any]:
    block: dict[str, Any] = kwargs["messages"][2]["content"][0]
    return block


def test_a_bridged_provider_gets_the_flag_as_a_prefix_on_string_content() -> None:
    folded = _tool_result(fold_tool_result_errors(_kwargs(BRIDGED, "blocked by referee")))

    assert "is_error" not in folded
    assert folded["content"] == "Error: blocked by referee"


def test_a_bridged_provider_gets_the_flag_as_a_leading_text_block() -> None:
    blocks = [{"type": "text", "text": "blocked by referee"}]

    folded = _tool_result(fold_tool_result_errors(_kwargs(BRIDGED, blocks)))

    assert "is_error" not in folded
    assert folded["content"] == [{"type": "text", "text": ERROR_PREFIX}, *blocks]


def test_empty_content_still_says_it_failed() -> None:
    folded = _tool_result(fold_tool_result_errors(_kwargs(BRIDGED, "")))

    assert folded["content"] == "Error:"


def test_a_native_messages_provider_keeps_the_flag() -> None:
    kwargs = _kwargs(NATIVE, "blocked by referee")

    assert fold_tool_result_errors(kwargs) is kwargs
    assert _tool_result(kwargs)["is_error"] is True


def test_a_result_without_the_flag_is_left_alone() -> None:
    for is_error in (None, False):
        kwargs = _kwargs(BRIDGED, "ok", is_error=is_error)
        assert fold_tool_result_errors(kwargs) is kwargs


def test_the_callers_request_is_not_mutated() -> None:
    kwargs = _kwargs(BRIDGED, "blocked by referee")

    fold_tool_result_errors(kwargs)

    assert _tool_result(kwargs) == {
        "type": "tool_result",
        "tool_use_id": "toolu_1",
        "content": "blocked by referee",
        "is_error": True,
    }


def test_an_unrecognized_model_is_left_alone() -> None:
    for model in ("nope:whatever", "no-provider-prefix"):
        kwargs = _kwargs(model, "blocked by referee")
        assert fold_tool_result_errors(kwargs) is kwargs
