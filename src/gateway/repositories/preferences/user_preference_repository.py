"""Data access for ``user_preferences``, the only module that constructs or queries it. Flushes, never commits."""

import uuid
from datetime import UTC, datetime
from typing import Any, Never

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as postgresql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from gateway.core.sql import dialect_name
from gateway.core.unit_of_work import UnitOfWork
from gateway.models.preferences import UserPreference
from gateway.repositories.base_repository import BaseRepository


class UserPreferenceRepository(BaseRepository[UserPreference, Never, Never]):
    """Read and stage one identity's preference rows."""

    def __init__(self, db: AsyncSession | UnitOfWork):
        super().__init__(db, UserPreference)

    async def find(self, user_id: uuid.UUID, key: str) -> UserPreference | None:
        """The row ``user_id`` stored under ``key``, or ``None``."""
        query = (
            select(UserPreference)
            .where(UserPreference.user_id == user_id, UserPreference.key == key)
            .execution_options(populate_existing=True)
        )
        return (await self.db.execute(query)).scalar_one_or_none()

    async def put(self, user_id: uuid.UUID, key: str, value: dict[str, Any]) -> UserPreference:
        """Stage ``value`` under ``key``, replacing a stored one.

        Two tabs can write a fresh key together, so the insert turns into an
        update on the unique ``(user_id, key)`` constraint and the later write
        is the one the row keeps.
        """
        now = datetime.now(UTC)
        insert = postgresql_insert if dialect_name(self.db) == "postgresql" else sqlite_insert
        await self.db.execute(
            insert(UserPreference)
            .values(id=uuid.uuid4(), user_id=user_id, key=key, value=value, updated_at=now)
            .on_conflict_do_update(
                index_elements=[UserPreference.user_id, UserPreference.key],
                set_={"value": value, "updated_at": now},
            )
        )
        await self.db.flush()
        stored = await self.find(user_id, key)
        if stored is None:
            raise RuntimeError("an upserted preference could not be read back")
        return stored

    async def remove(self, user_id: uuid.UUID, key: str) -> None:
        """Stage the removal of ``user_id``'s row under ``key``, if there is one."""
        await self.db.execute(
            delete(UserPreference).where(UserPreference.user_id == user_id, UserPreference.key == key)
        )
        await self.db.flush()
