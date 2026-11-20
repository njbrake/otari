"""Moving a merged user's API keys onto the user it was merged into."""

from collections.abc import Mapping

from gateway.repositories.api_keys import ApiKeyRepositories


class ApiKeyUserMergeListener:
    """Moves a merged user's keys inside the caller's Unit of Work block, so they bill the user merged into."""

    def __init__(self, repositories: ApiKeyRepositories) -> None:
        self._keys = repositories.keys

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Point every key of ``from_user_id`` at ``to_user_id``."""
        return {"api_keys": await self._keys.reassign_user(from_user_id, to_user_id)}
