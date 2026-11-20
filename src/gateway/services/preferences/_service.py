"""A signed-in person's own dashboard preferences."""

import uuid

from gateway.core.unit_of_work import UnitOfWork
from gateway.models.preferences import PreferenceKey
from gateway.repositories.preferences import UserPreferenceRepository
from gateway.schemas.preferences import UserPreferencePublic, UserPreferenceUpdate


class PreferenceService:
    """Reads, replaces and clears the preferences one identity stored. Every method acts on that identity alone."""

    def __init__(self, uow: UnitOfWork, preferences: UserPreferenceRepository) -> None:
        self._uow = uow
        self._preferences = preferences

    async def get(self, user_id: uuid.UUID, key: PreferenceKey) -> UserPreferencePublic:
        """What ``user_id`` stored under ``key``, or the key with no value when nothing is."""
        async with self._uow:
            row = await self._preferences.find(user_id, key.value)
            return UserPreferencePublic.of(key, row)

    async def put(self, user_id: uuid.UUID, key: PreferenceKey, request: UserPreferenceUpdate) -> UserPreferencePublic:
        """Store ``request.value`` under ``key`` in place of anything stored there."""
        async with self._uow:
            row = await self._preferences.put(user_id, key.value, request.value)
            return UserPreferencePublic.of(key, row)

    async def clear(self, user_id: uuid.UUID, key: PreferenceKey) -> None:
        """Forget what ``user_id`` stored under ``key``; a key with nothing stored is left as it is."""
        async with self._uow:
            await self._preferences.remove(user_id, key.value)
