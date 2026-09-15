"""Relabeling of the ``model`` field on provider results and stream chunks."""

from typing import Any

__all__ = ["SERVED_MODEL_HEADER", "relabel_model", "served_model_headers"]

SERVED_MODEL_HEADER = "X-Otari-Served-Model"


def relabel_model(obj: Any, display_model: str) -> Any:
    """Rewrite the ``model`` field on a result or stream chunk in place.

    Used to echo the name the caller sent (a selector, alias, or policy name)
    instead of the upstream model's own name. Handles the top-level ``model``
    field (OpenAI chat chunks and every non-streaming result object) plus the
    nested locations streaming start
    events carry it in: Anthropic ``message_start`` (``.message.model``) and the
    Responses events (``.response.model``). Chunks with no model field anywhere
    are left untouched, so this is safe to call on every chunk of any format.
    """
    for holder in (obj, getattr(obj, "message", None), getattr(obj, "response", None)):
        if holder is not None and hasattr(holder, "model"):
            try:
                holder.model = display_model
            except (AttributeError, ValueError):  # frozen / validated field, leave as-is
                pass
    return obj


def served_model_headers(obj: Any, *, requested: str, provider: str, model: str) -> dict[str, str]:
    """The provider's own name for the model that served, as a response header.

    Only when the caller named ``provider:model`` explicitly and the provider
    reports a different name (a dated snapshot, say): an alias or routing policy
    hides its target, and a name equal to the requested one says nothing new.
    Read before :func:`relabel_model` overwrites the field.
    """
    if requested != f"{provider}:{model}":
        return {}
    served = getattr(obj, "model", None)
    if not isinstance(served, str) or not served or served == model:
        return {}
    return {SERVED_MODEL_HEADER: served}
