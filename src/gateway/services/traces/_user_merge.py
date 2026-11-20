"""Moving a merged user's agent traces onto the user it was merged into."""

from collections.abc import Mapping

from gateway.repositories.traces import TracesRepositories


class TraceUserMergeListener:
    """Moves a merged user's traces inside the caller's Unit of Work block, so the user merged into owns them."""

    def __init__(self, repositories: TracesRepositories) -> None:
        self._traces = repositories.traces

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Point every trace of ``from_user_id`` at ``to_user_id``."""
        return {"traces": await self._traces.reassign_user(from_user_id, to_user_id)}
