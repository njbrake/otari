"""Request and response models of the preferences domain."""

import json
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, JsonValue, field_validator

from gateway.models.preferences import MAX_PREFERENCE_BYTES, PreferenceKey, UserPreference


def preference_size(value: dict[str, Any]) -> int:
    """The bytes ``value`` takes as compact JSON, which is what the size limit counts."""
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())


class UserPreferenceUpdate(BaseModel):
    """The whole value to store under a key, replacing whatever was there."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"example": {"value": {"widths": {"model": 240}, "hidden": ["routing"]}}},
    )

    value: dict[str, JsonValue] = Field(
        description=(
            f"A JSON object of the dashboard's own shape, at most {MAX_PREFERENCE_BYTES} bytes as compact "
            "JSON. The gateway stores it as given and never reads inside it."
        ),
    )

    @field_validator("value")
    @classmethod
    def _bounded(cls, value: dict[str, JsonValue]) -> dict[str, JsonValue]:
        if preference_size(value) > MAX_PREFERENCE_BYTES:
            raise ValueError(f"A preference holds at most {MAX_PREFERENCE_BYTES} bytes of JSON")
        return value


class UserPreferencePublic(BaseModel):
    """One of the caller's preferences, or the key alone when nothing is stored under it."""

    key: PreferenceKey
    value: dict[str, JsonValue] | None = Field(
        description="What the dashboard stored, or null when nothing is, so the dashboard uses its defaults."
    )
    updated_at: datetime | None = Field(description="When it was last written, or null when nothing is stored.")

    @classmethod
    def of(cls, key: PreferenceKey, row: UserPreference | None) -> "UserPreferencePublic":
        """The answer for ``key``, from its stored row where there is one."""
        if row is None:
            return cls(key=key, value=None, updated_at=None)
        return cls(key=key, value=row.value, updated_at=row.updated_at)
