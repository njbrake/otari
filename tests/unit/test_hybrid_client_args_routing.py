"""Regression test that a hybrid-mode attempt's ``extra_params`` actually
reach the provider's client constructor through the real any-llm SDK, not
just that our own code produces a kwargs dict that *looks* right.

``default_attempt_kwargs`` merges ``extra_params`` under ``client_args``
specifically because any-llm's ``acompletion()`` only forwards a
``client_args`` mapping to the provider's client constructor (everything
else in ``**kwargs`` goes to the completion *call* instead). A test that
monkeypatches ``acompletion`` directly (as the hybrid-mode integration tests
do) can't catch a regression back to flat kwargs, because the fake
``acompletion`` never exercises any-llm's own kwarg-splitting logic. This
test calls into the real SDK, stopping only at the OpenAI client's
construction (patched so no network call is made), to verify the values
land where the client constructor receives them.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest
from any_llm import acompletion

from gateway.api.routes._platform import ResolvedAttempt, default_attempt_kwargs


@pytest.mark.asyncio
async def test_extra_params_reach_the_real_client_constructor() -> None:
    attempt = ResolvedAttempt(
        attempt_id="a0",
        position=0,
        provider="openai",
        model="gpt-4o-mini",
        api_key="sk-test",
        managed=False,
        extra_params={"organization": "org-example", "project": "proj-example"},
    )
    kwargs = default_attempt_kwargs(attempt, {"messages": [{"role": "user", "content": "hi"}]})

    captured: dict[str, Any] = {}

    class _StopBeforeNetworkCall(Exception):
        pass

    def fake_async_openai(**client_kwargs: Any) -> Any:
        captured.update(client_kwargs)
        raise _StopBeforeNetworkCall

    with patch("any_llm.providers.openai.base.AsyncOpenAI", side_effect=fake_async_openai):
        with pytest.raises(_StopBeforeNetworkCall):
            await acompletion(**kwargs)

    assert captured["organization"] == "org-example"
    assert captured["project"] == "proj-example"
    assert captured["api_key"] == "sk-test"
