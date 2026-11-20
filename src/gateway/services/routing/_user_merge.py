"""Moving a merged user's own routing policies onto the user it was merged into."""

from collections.abc import Mapping

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeRefusedError
from gateway.repositories.routing import RoutingPolicyRepository


class RoutingUserMergeListener:
    """Moves a merged user's per-user routing policies inside the caller's Unit of Work block.

    The caller refreshes the policy cache once the merge commits.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        self._policies = RoutingPolicyRepository(uow)

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Point the policies at ``to_user_id``, refusing where both users hold one of a name in one workspace."""
        shared = await self._policies.shared_with_user(from_user_id, to_user_id, by=("workspace_id", "name"))
        if shared:
            raise UserMergeRefusedError(
                "Both users have a routing policy of the same name in one workspace: "
                + ", ".join(sorted(str(name) for _, name in shared))
            )
        return {"routing_policies": await self._policies.reassign_user(from_user_id, to_user_id)}
