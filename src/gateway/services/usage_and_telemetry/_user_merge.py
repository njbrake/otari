"""Moving a merged user's usage history onto the user it was merged into."""

from collections.abc import Mapping

from gateway.core.unit_of_work import UnitOfWork
from gateway.repositories.usage_and_telemetry import UsageLogRepository


class UsageUserMergeListener:
    """Moves a merged user's usage rows inside the caller's Unit of Work block, unchanged but for their owner.

    Agent telemetry is the telemetry store's, which the merge moves on its own.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        self._usage_logs = UsageLogRepository(uow)

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Point every usage row of ``from_user_id`` at ``to_user_id``."""
        return {"usage_logs": await self._usage_logs.reassign_user(from_user_id, to_user_id)}
