"""Moving a merged user's budget history onto the user it was merged into."""

from collections.abc import Mapping

from gateway.exceptions.organizations_exceptions import UserMergeRefusedError
from gateway.repositories.budgets import BudgetRepositories


class BudgetUserMergeListener:
    """Moves a merged user's settled reservations and reset history inside the caller's Unit of Work block."""

    def __init__(self, repositories: BudgetRepositories) -> None:
        self._budgets = repositories.budgets
        self._reservations = repositories.reservations

    async def user_merged(self, from_user_id: str, to_user_id: str, *, preview: bool) -> Mapping[str, int]:
        """Point the settled reservations and the reset history at ``to_user_id``, refusing while one is in flight.

        A reservation in flight settles against the user it was taken for, so
        moving it would settle the merged user's request on the other user's counters.
        """
        if await self._reservations.has_active(from_user_id):
            raise UserMergeRefusedError(
                f"User '{from_user_id}' has a budget reservation in flight; retry once its requests finish"
            )
        if preview:
            return {
                "budget_reservations": await self._reservations.count_naming_user(from_user_id),
                "budget_reset_logs": await self._budgets.count_reset_logs(from_user_id),
            }
        return {
            "budget_reservations": await self._reservations.reassign_user(from_user_id, to_user_id),
            "budget_reset_logs": await self._budgets.reassign_reset_logs(from_user_id, to_user_id),
        }

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
