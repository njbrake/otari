"""Moving a merged user's own routing policies onto the user it was merged into."""

import uuid
from collections.abc import Collection, Mapping
from typing import Any

from gateway.core.config import GatewayConfig
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeRefusedError
from gateway.repositories.routing import RoutingPolicyRepository


def names_user(spec: Mapping[str, Any], user_id: str) -> bool:
    """Whether a policy spec's ``when.user_id`` conditions name ``user_id``."""
    for entry in spec.get("select") or []:
        when = entry.get("when") if isinstance(entry, Mapping) else None
        named = when.get("user_id") if isinstance(when, Mapping) else None
        if named == user_id or (isinstance(named, list) and user_id in named):
            return True
    return False


class RoutingUserMergeListener:
    """Moves a merged user's per-user routing policies inside the caller's Unit of Work block.

    A policy whose ``when.user_id`` condition names the merged user would stop
    matching once its requests bill another user, so the merge is refused until
    those conditions are changed. The caller refreshes the policy cache once the
    merge commits.
    """

    def __init__(self, uow: UnitOfWork, config: GatewayConfig) -> None:
        self._policies = RoutingPolicyRepository(uow)
        self._config = config

    async def rows_elsewhere(self, user_id: str, workspace_ids: Collection[uuid.UUID]) -> list[str]:
        """The tables holding a row of ``user_id`` in a workspace other than these."""
        return ["routing_policies"] if await self._policies.has_user_rows_outside(user_id, workspace_ids) else []

    async def user_merged(
        self, from_user_id: str, to_user_id: str, *, preview: bool, resumed: bool
    ) -> Mapping[str, int]:
        """Point the policies at ``to_user_id``, refusing where a condition names the merged user or a name clashes."""
        conditioned = sorted(
            {name for name, _workspace, spec in await self._policies.specs() if names_user(spec, from_user_id)}
            | {
                name
                for name, policy in self._config.routing.policies.items()
                if names_user(policy.model_dump(mode="json", exclude_none=True), from_user_id)
            }
        )
        if conditioned:
            raise UserMergeRefusedError(
                f"These routing policies have a condition naming user '{from_user_id}'; change it first: "
                + ", ".join(conditioned)
            )
        shared = await self._policies.shared_with_user(from_user_id, to_user_id, by=("workspace_id", "name"))
        if shared:
            raise UserMergeRefusedError(
                "Both users have a routing policy of the same name in one workspace: "
                + ", ".join(sorted(str(name) for _, name in shared))
            )
        if preview:
            return {"routing_policies": await self._policies.count_naming_user(from_user_id)}
        return {"routing_policies": await self._policies.reassign_user(from_user_id, to_user_id)}

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
