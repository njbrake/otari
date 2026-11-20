"""Tables the preferences domain owns: what a signed-in person chose about how the dashboard looks."""

import uuid
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import JSON, ForeignKey, String, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from gateway.models.base import Base, UtcDateTime

# The most a stored value may take, serialized as compact JSON.
MAX_PREFERENCE_BYTES = 16 * 1024
MAX_PREFERENCE_KEY_LENGTH = 64


class PreferenceKey(StrEnum):
    """Every preference a person can store. A new one is added here, so nothing else can be written."""

    TABLE_SESSIONS = "table:sessions"
    TABLE_REQUESTS = "table:requests"


class UserPreference(Base):
    """One preference of one dashboard identity, as the dashboard wrote it.

    The value is the dashboard's own document. The gateway bounds its size and
    never reads inside it, so the dashboard validates what it reads back.
    """

    __tablename__ = "user_preferences"
    # The unique constraint leads with ``user_id``, so it also serves as that column's index.
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_preferences_user_key"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, ForeignKey("user.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(String(MAX_PREFERENCE_KEY_LENGTH), nullable=False)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(),
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
