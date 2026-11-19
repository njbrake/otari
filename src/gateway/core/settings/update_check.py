"""Settings for the check for new otari releases and security fixes."""

from typing import Annotated

from pydantic import BaseModel, Field

from gateway.core.settings_view import OMITTED, SettingsGroup, Shown

DEFAULT_UPDATE_CHECK_URL = "https://api.otari.ai/api/v1/update-checks"


class UpdateCheckSettings(BaseModel):
    # Fork: off by default, so the dashboard never asks, and nothing is sent even
    # when it is turned on (services/update_check/_service.py `_send`).
    update_check: Annotated[bool | None, Shown(SettingsGroup.GENERAL)] = Field(
        default=False,
        description=(
            "Check otari.ai for new releases and security fixes. This build never sends the check, whatever this says."
        ),
    )
    update_check_url: Annotated[str, OMITTED] = Field(
        default=DEFAULT_UPDATE_CHECK_URL,
        description="Where the update check is sent.",
    )
