"""Moving a merged user's files onto the user it was merged into."""

from collections.abc import Mapping

from gateway.repositories.files import FileRepositories


class FileUserMergeListener:
    """Moves a merged user's files inside the caller's Unit of Work block, so the user merged into owns them."""

    def __init__(self, repositories: FileRepositories) -> None:
        self._files = repositories.files

    async def user_merged(self, from_user_id: str, to_user_id: str, *, preview: bool) -> Mapping[str, int]:
        """Point every file of ``from_user_id`` at ``to_user_id``, or with ``preview`` count them."""
        if preview:
            return {"file_objects": await self._files.count_naming_user(from_user_id)}
        return {"file_objects": await self._files.reassign_user(from_user_id, to_user_id)}

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
