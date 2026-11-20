"""Moving a merged user's usage history onto the user it was merged into."""

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeRefusedError
from gateway.repositories.usage_and_telemetry import UsageLogRepository

RECENT_USAGE = timedelta(minutes=5)
"""How recent a usage row has to be for its user to count as still sending requests."""


class UsageUserMergeListener:
    """Moves a merged user's usage rows inside the caller's Unit of Work block, unchanged but for their owner.

    Agent telemetry is the telemetry store's, which the merge moves on its own.
    The hourly rollups follow without a write here: the trigger on ``usage_logs``
    marks each hour a moved row was in for the refresh to rebuild.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        self._usage_logs = UsageLogRepository(uow)

    async def user_merged(self, from_user_id: str, to_user_id: str, *, preview: bool) -> Mapping[str, int]:
        """Point every usage row of ``from_user_id`` at ``to_user_id``, or with ``preview`` count them.

        Refused while the user is still sending requests: a row written after the
        move, by the log writer's batch, would land on the retired user.
        """
        if await self._usage_logs.has_rows_since(from_user_id, datetime.now(UTC) - RECENT_USAGE):
            minutes = int(RECENT_USAGE.total_seconds() // 60)
            raise UserMergeRefusedError(
                f"User '{from_user_id}' sent a request in the last {minutes} minutes and may still be sending them; "
                "retry once it has been quiet that long"
            )
        if preview:
            return {"usage_logs": await self._usage_logs.count_naming_user(from_user_id)}
        return {"usage_logs": await self._usage_logs.reassign_user(from_user_id, to_user_id)}

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
