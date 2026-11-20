"""Moving a merged user's idempotency records and video jobs onto the user it was merged into."""

from collections.abc import Mapping

from gateway.repositories.inference import InferenceRepositories


class InferenceUserMergeListener:
    """Moves a merged user's idempotency records and video jobs inside the caller's Unit of Work block."""

    def __init__(self, repositories: InferenceRepositories) -> None:
        self._idempotency = repositories.idempotency
        self._video_jobs = repositories.video_jobs

    async def user_merged(self, from_user_id: str, to_user_id: str, *, preview: bool) -> Mapping[str, int]:
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
