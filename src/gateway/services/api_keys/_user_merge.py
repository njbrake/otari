"""Moving a merged user's API keys onto the user it was merged into."""

import uuid
from collections.abc import Collection, Mapping

from gateway.repositories.api_keys import ApiKeyRepositories


class ApiKeyUserMergeListener:
    """Moves a merged user's keys inside the caller's Unit of Work block, so they bill the user merged into."""

    def __init__(self, repositories: ApiKeyRepositories) -> None:
        self._keys = repositories.keys

    async def rows_elsewhere(self, user_id: str, workspace_ids: Collection[uuid.UUID]) -> list[str]:
        """The tables holding a row of ``user_id`` in a workspace other than these."""
        return ["api_keys"] if await self._keys.has_user_rows_outside(user_id, workspace_ids) else []

    async def user_merged(
        self, from_user_id: str, to_user_id: str, *, preview: bool, resumed: bool
    ) -> Mapping[str, int]:
        """Point every key of ``from_user_id`` at ``to_user_id``, or with ``preview`` count them."""
        if preview:
            return {"api_keys": await self._keys.count_naming_user(from_user_id)}
        return {"api_keys": await self._keys.reassign_user(from_user_id, to_user_id)}

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
