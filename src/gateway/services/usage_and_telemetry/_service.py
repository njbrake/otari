"""The usage domain's reads, each in a block of its own on the Unit of Work it was built with."""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from gateway.core.unit_of_work import UnitOfWork
from gateway.repositories.usage_and_telemetry import NameAttempts, ServedTraffic, UsageLogRepository


@dataclass(frozen=True)
class TrafficReach:
    """The workspaces a reader reads, and whose rows in them they may see as someone's.

    ``everyone_in`` are the workspaces whose every row is theirs to see (None:
    all of ``workspace_ids``); in the rest they see their own rows alone, by
    ``own_user_id``. The rule the organization's usage reads draw.
    """

    workspace_ids: frozenset[uuid.UUID]
    everyone_in: frozenset[uuid.UUID] | None
    own_user_id: str | None


class UsageService:
    """Usage rows, read inside a tenant scope the caller derived."""

    def __init__(self, uow: UnitOfWork, usage_logs: UsageLogRepository) -> None:
        self._uow = uow
        self._usage_logs = usage_logs

    async def served_traffic(
        self,
        *,
        workspace_ids: Collection[uuid.UUID],
        since: datetime,
        reach: TrafficReach | None = None,
        api_key_ids: Collection[str] | None = None,
    ) -> list[ServedTraffic]:
        """The requests served here since ``since`` in these workspaces, by name sent, offering reached and key.

        A row's key is named only where ``reach`` lets the reader see whose it is;
        with no ``reach``, never. ``api_key_ids`` narrows to rows the reader may see.
        """
        async with self._uow:
            return await self._usage_logs.served_traffic(
                workspace_ids=workspace_ids,
                since=since,
                everyone_in=reach.everyone_in if reach is not None else frozenset(),
                own_user_id=reach.own_user_id if reach is not None else None,
                api_key_ids=api_key_ids,
            )

    async def name_attempts(
        self,
        *,
        reach: TrafficReach,
        since: datetime,
        names: Collection[str],
        api_key_ids: Collection[str] | None = None,
    ) -> list[NameAttempts]:
        """The attempts made since ``since`` for these names sent, among the rows ``reach`` lets the reader see."""
        async with self._uow:
            return await self._usage_logs.name_attempts(
                workspace_ids=reach.workspace_ids,
                since=since,
                names=names,
                everyone_in=reach.everyone_in,
                own_user_id=reach.own_user_id,
                api_key_ids=api_key_ids,
            )
