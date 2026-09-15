"""Fold ``is_error`` on Anthropic tool results into their text before a bridged dispatch.

any-llm serves a Messages request for a provider with no native Messages API by
converting it to an OpenAI chat request, and that conversion copies a tool
result's ``is_error: true`` onto the ``role: tool`` message it emits
(mozilla-ai/any-llm#1312). OpenAI has no such field, and a strict
OpenAI-compatible backend such as Fireworks refuses the whole request with 400.
So for those providers the flag becomes an ``Error:`` prefix on the result's
text, which every backend reads, and a provider with a native Messages API
keeps the flag.

Stopgap: remove once any-llm stops forwarding the field and the SDK pin moves
past that release.
"""

from typing import Any

from any_llm import AnyLLM
from any_llm.exceptions import UnsupportedProviderError

ERROR_PREFIX = "Error: "


def fold_tool_result_errors(kwargs: dict[str, Any]) -> dict[str, Any]:
    """Return ``kwargs`` with tool-result errors folded into text when any-llm will bridge the call.

    The caller's dict and messages are never mutated; ``kwargs`` itself comes
    back when nothing needed folding.
    """
    model = kwargs.get("model")
    messages = kwargs.get("messages")
    if not isinstance(model, str) or not isinstance(messages, list) or not _bridged(model):
        return kwargs
    folded = [_fold_message(message) for message in messages]
    if all(new is old for new, old in zip(folded, messages, strict=True)):
        return kwargs
    return {**kwargs, "messages": folded}


def _bridged(model: str) -> bool:
    """Whether any-llm converts a Messages call for this model's provider into chat completions."""
    try:
        provider, _ = AnyLLM.split_model_provider(model)
        provider_class = AnyLLM.get_provider_class(provider)
    except (ValueError, ImportError, UnsupportedProviderError):
        return False
    return provider_class._amessages is AnyLLM._amessages


def _fold_message(message: Any) -> Any:
    if not isinstance(message, dict) or not isinstance(message.get("content"), list):
        return message
    blocks = message["content"]
    folded = [_fold_block(block) for block in blocks]
    if all(new is old for new, old in zip(folded, blocks, strict=True)):
        return message
    return {**message, "content": folded}


def _fold_block(block: Any) -> Any:
    if not isinstance(block, dict) or block.get("type") != "tool_result" or block.get("is_error") is not True:
        return block
    folded = {key: value for key, value in block.items() if key != "is_error"}
    content = block.get("content")
    if isinstance(content, list):
        folded["content"] = [{"type": "text", "text": ERROR_PREFIX}, *content]
    elif isinstance(content, str) and content:
        folded["content"] = ERROR_PREFIX + content
    else:
        folded["content"] = ERROR_PREFIX.strip()
    return folded
