"""Fork gate: this deployment never reports its version or install id to otari.ai.

Upstream's update check sends both to ``api.otari.ai`` once an operator opts in.
This fork keeps the setting off and makes the send refuse whatever the setting
says. Each check fails if an upstream sync turns either back on.
"""

import uuid

import pytest

from gateway.core.config import GatewayConfig
from gateway.services.update_check._client import UpdateCheckFailedError
from gateway.services.update_check._service import _send


def test_the_setting_is_off_by_default() -> None:
    assert GatewayConfig.model_fields["update_check"].default is False


@pytest.mark.asyncio
async def test_the_send_never_reaches_the_network() -> None:
    with pytest.raises(UpdateCheckFailedError):
        await _send("https://api.otari.ai/api/v1/update-checks", "1.0.0", uuid.uuid4())
