"""Moving a merged user's own provider endpoints onto the user it was merged into."""

from collections.abc import Mapping

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeRefusedError
from gateway.repositories.providers import ProviderEndpointRepository


class ProviderEndpointUserMergeListener:
    """Moves a merged user's per-user provider endpoints inside the caller's Unit of Work block.

    The caller refreshes the endpoint cache once the merge commits.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        self._endpoints = ProviderEndpointRepository(uow)

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Point the endpoints at ``to_user_id``, refusing where both users hold one of a name in one workspace."""
        shared = await self._endpoints.shared_with_user(from_user_id, to_user_id, by=("workspace_id", "name"))
        if shared:
            raise UserMergeRefusedError(
                "Both users have a provider endpoint of the same name in one workspace: "
                + ", ".join(sorted(str(name) for _, name in shared))
            )
        return {"provider_endpoints": await self._endpoints.reassign_user(from_user_id, to_user_id)}
