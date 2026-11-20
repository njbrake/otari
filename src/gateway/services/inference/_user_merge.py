"""Moving a merged user's idempotency records and video jobs onto the user it was merged into."""

import uuid
from collections.abc import Collection, Mapping

from gateway.repositories.inference import InferenceRepositories


class InferenceUserMergeListener:
    """Moves a merged user's idempotency records and video jobs inside the caller's Unit of Work block."""

    def __init__(self, repositories: InferenceRepositories) -> None:
        self._idempotency = repositories.idempotency
        self._video_jobs = repositories.video_jobs

    async def rows_elsewhere(self, user_id: str, workspace_ids: Collection[uuid.UUID]) -> list[str]:
        """The tables holding a row of ``user_id`` in a workspace other than these."""
        return ["video_jobs"] if await self._video_jobs.has_user_rows_outside(user_id, workspace_ids) else []

    async def user_merged(
        self, from_user_id: str, to_user_id: str, *, preview: bool, resumed: bool
    ) -> Mapping[str, int]:
        """Point both at ``to_user_id``, so a retried request or a job's poll still finds its owner.

        With ``preview`` count them.
        """
        if preview:
            return {
                "idempotency_keys": await self._idempotency.count_naming_user(from_user_id),
                "video_jobs": await self._video_jobs.count_naming_user(from_user_id),
            }
        return {
            "idempotency_keys": await self._idempotency.reassign_user(from_user_id, to_user_id),
            "video_jobs": await self._video_jobs.reassign_user(from_user_id, to_user_id),
        }

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
