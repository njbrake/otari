"""Data access for ``usage_logs``, one row per attempt the gateway served or imported. Flushes, never commits."""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Never

from sqlalchemy import ColumnElement, and_, case, false, func, or_, select, true

from gateway.core.unit_of_work import UnitOfWork
from gateway.models.usage import SERVED_HERE_SLUG, UsageLog
from gateway.repositories.base_repository import BaseRepository

# The statuses that end a request. ``absorbed`` is an attempt a later one recovered
# from, so counting it would count one request twice.
_REQUEST_STATUSES = ("success", "error")


@dataclass(frozen=True)
class ServedTraffic:
    """The requests this gateway served for one name sent and one offering reached.

    ``model`` is the provider's own id, or a whole selector on a row written before
    ``provider`` was recorded. ``fell_back`` counts the successful requests a
    later attempt served.
    """

    provider: str | None
    model: str
    policy_name: str | None
    requests: int
    fell_back: int
    api_key_id: str | None = None
    """The key that sent them, where the reader may see whose rows they are; None otherwise."""


@dataclass(frozen=True)
class NameAttempts:
    """The attempts made in one workspace for one name sent, by one owner and key, at one step of the plan."""

    workspace_id: uuid.UUID
    name: str
    user_id: str | None
    api_key_id: str | None
    position: int
    status: str
    attempts: int


def _readable(everyone_in: Collection[uuid.UUID] | None, own_user_id: str | None) -> ColumnElement[bool]:
    """Rows a reader may see as someone's: every row in a workspace of ``everyone_in`` (None: all), else their own."""
    if everyone_in is None:
        return true()
    mine = UsageLog.user_id == own_user_id if own_user_id is not None else false()
    return or_(UsageLog.workspace_id.in_(sorted(everyone_in)), mine) if everyone_in else mine


class UsageLogRepository(BaseRepository[UsageLog, Never, Never]):
    """Read usage rows inside a set of workspaces."""

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, UsageLog)

    async def served_traffic(
        self,
        *,
        workspace_ids: Collection[uuid.UUID],
        since: datetime,
        everyone_in: Collection[uuid.UUID] | None = None,
        own_user_id: str | None = None,
        api_key_ids: Collection[str] | None = None,
    ) -> list[ServedTraffic]:
        """The requests served here since ``since`` in these workspaces, grouped by name sent, offering and key.

        One grouped read. Imported usage is left out, because it was never served
        here. A row's key is reported only where the reader may see whose it is
        (``everyone_in``, else ``own_user_id``'s own). ``api_key_ids`` narrows to
        those keys' rows, and only to ones the reader may see as someone's.
        """
        if not workspace_ids:
            return []
        readable = _readable(everyone_in, own_user_id)
        key = case((readable, UsageLog.api_key_id), else_=None)
        fell_back = func.sum(case((and_(UsageLog.status == "success", UsageLog.attempt_position > 1), 1), else_=0))
        stmt = (
            select(
                UsageLog.provider,
                UsageLog.model,
                UsageLog.policy_name,
                key.label("api_key_id"),
                func.count().label("requests"),
                func.coalesce(fell_back, 0).label("fell_back"),
            )
            .where(
                UsageLog.workspace_id.in_(sorted(workspace_ids)),
                UsageLog.source == SERVED_HERE_SLUG,
                UsageLog.status.in_(_REQUEST_STATUSES),
                UsageLog.timestamp >= since,
            )
            .group_by(UsageLog.provider, UsageLog.model, UsageLog.policy_name, key)
        )
        if api_key_ids is not None:
            stmt = stmt.where(UsageLog.api_key_id.in_(sorted(api_key_ids)), readable)
        return [
            ServedTraffic(
                provider=row.provider,
                model=row.model,
                policy_name=row.policy_name,
                requests=int(row.requests),
                fell_back=int(row.fell_back),
                api_key_id=row.api_key_id,
            )
            for row in (await self.db.execute(stmt)).all()
        ]

    async def name_attempts(
        self,
        *,
        workspace_ids: Collection[uuid.UUID],
        since: datetime,
        names: Collection[str],
        everyone_in: Collection[uuid.UUID] | None,
        own_user_id: str | None,
        api_key_ids: Collection[str] | None = None,
    ) -> list[NameAttempts]:
        """The attempts made here since ``since`` for these names sent, by workspace, owner, key, step and outcome.

        Only rows the reader may see as someone's (``everyone_in``, else
        ``own_user_id``'s own), narrowed to ``api_key_ids`` when given. A row with
        no step recorded is the first step. Imported usage is left out.
        """
        if not workspace_ids or not names:
            return []
        position = func.coalesce(UsageLog.attempt_position, 1)
        stmt = (
            select(
                UsageLog.workspace_id,
                UsageLog.requested_model,
                UsageLog.user_id,
                UsageLog.api_key_id,
                position.label("position"),
                UsageLog.status,
                func.count().label("attempts"),
            )
            .where(
                UsageLog.workspace_id.in_(sorted(workspace_ids)),
                UsageLog.requested_model.in_(sorted(names)),
                UsageLog.source == SERVED_HERE_SLUG,
                UsageLog.status.in_((*_REQUEST_STATUSES, "absorbed")),
                UsageLog.timestamp >= since,
                _readable(everyone_in, own_user_id),
            )
            .group_by(
                UsageLog.workspace_id,
                UsageLog.requested_model,
                UsageLog.user_id,
                UsageLog.api_key_id,
                position,
                UsageLog.status,
            )
        )
        if api_key_ids is not None:
            stmt = stmt.where(UsageLog.api_key_id.in_(sorted(api_key_ids)))
        return [
            NameAttempts(
                workspace_id=row.workspace_id,
                name=row.requested_model,
                user_id=row.user_id,
                api_key_id=row.api_key_id,
                position=int(row.position),
                status=row.status,
                attempts=int(row.attempts),
            )
            for row in (await self.db.execute(stmt)).all()
        ]
