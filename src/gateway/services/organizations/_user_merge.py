"""Merging one billing user into another.

A ``users`` row is what keys, usage, budgets and per-user routing state bill
through, and two rows can name one person: an id typed by hand before sign-in
existed, and the row a sign-in account bills through under its identity's UUID.
A merge moves every row that names the source onto the target in one
transaction and retires the source with a note of where it went, so the
person's keys and history follow the account they sign in with. The target
keeps its own budget, access lists, blocked flag and spend counters: those
count a budget window or a lifetime by the target's own budget, so adding
another user's would count spend twice or in the wrong window, and the usage
rows that moved already carry the history.
"""

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeIntoItselfError, UserMergeRefusedError
from gateway.log_config import logger
from gateway.models.users import User
from gateway.ports.telemetry_storage_port import TelemetryFilter, TelemetryStoragePort
from gateway.repositories.organizations import OrganizationRepositories
from gateway.repositories.tenancy import UserRepository
from gateway.repositories.users_repository import DEFAULT_USER_ID

MERGED_INTO_KEY = "merged_into"
"""The key a retired user's metadata names the user it was merged into under."""


class UserMergeListener(Protocol):
    """Moves one domain's rows that name a billing user onto another, inside the caller's Unit of Work block.

    NOTE: an implementation must not commit or roll back. It names every table it
    moves rows in, with the count moved, a table with none included, and raises
    ``UserMergeRefusedError`` when its rows cannot move, on a preview too.
    """

    async def user_merged(self, from_user_id: str, to_user_id: str, *, preview: bool) -> Mapping[str, int]:
        """Stage moving this domain's rows from one user to the other; the rows moved per table.

        With ``preview`` write nothing and count what would move.
        """
        ...

    async def merge_committed(self) -> None:
        """Act on the merge once it has committed, such as ending tokens a dropped row held."""
        ...


@dataclass(frozen=True)
class UserMerge:
    """What a merge moved, or on a preview would move."""

    from_user_id: str
    to_user_id: str
    moved: dict[str, int]
    """Rows per table, every table that names a user listed."""
    preview: bool
    resumed: bool
    """The source was already merged into the target, and this moved what reached it since."""


class UserMergeService:
    """Merge one billing user into another for an operator. Each write runs in a Unit of Work block."""

    def __init__(
        self,
        uow: UnitOfWork,
        repositories: OrganizationRepositories,
        accounts: UserRepository,
        *,
        telemetry: TelemetryStoragePort,
        refresh_caches: Callable[[], Awaitable[None]],
        listeners: Sequence[UserMergeListener],
    ) -> None:
        """``refresh_caches`` reloads the aliases, routing policies and provider endpoints a merge may have moved."""
        self._uow = uow
        self._refresh_caches = refresh_caches
        self._users = repositories.users
        self._accounts = accounts
        self._telemetry = telemetry
        self._listeners = listeners

    async def merge(
        self,
        from_user_id: str,
        to_user_id: str,
        *,
        organization_id: uuid.UUID,
        merged_by: str | None,
        preview: bool = False,
    ) -> UserMerge:
        """Move what names ``from_user_id`` onto ``to_user_id`` and retire it, or with ``preview`` say what would move.

        A preview counts and writes nothing. A merge runs the preview's checks
        first, then moves the source's agent telemetry, which a store outside this
        database cannot share the transaction, then the rest in one transaction.
        A merge refused or failed after the telemetry moved leaves it on the
        target, and running the merge again finishes it.

        Running it again for a source already merged into this target moves what
        reached the source since, such as usage the log writer wrote late, and
        leaves the source retired as it was.

        Raises:
            UserMergeIntoItselfError: Both ids name one user.
            UserMergeRefusedError: The source is a sign-in account's own user or the shared ``default`` user, another
                organization than ``organization_id`` also reaches the source, either user is gone (the source may be
                retired only into this target), the source is still sending requests or has a budget reservation in
                flight, a routing policy's condition names the source, or both users hold something only one of
                them may: a per-user alias, routing policy or provider endpoint of one name in one workspace, or an
                end user of one id.
        """
        if from_user_id == to_user_id:
            raise UserMergeIntoItselfError
        if await self._is_sign_in_account(from_user_id):
            raise UserMergeRefusedError(
                f"User '{from_user_id}' is the one a sign-in account bills through and cannot be retired; "
                "merge it the other way round"
            )
        if from_user_id == DEFAULT_USER_ID:
            raise UserMergeRefusedError(
                f"User '{from_user_id}' is the one keys minted without an owner bill to and cannot be retired"
            )
        telemetry = await self._telemetry.count(filters=TelemetryFilter(user_ids=(from_user_id,)))
        planned = await self._run(
            from_user_id, to_user_id, organization_id=organization_id, merged_by=merged_by, preview=True
        )
        planned.moved["agent_telemetry"] = telemetry
        if preview:
            return planned
        telemetry = await self._telemetry.reassign_user(from_user_id=from_user_id, to_user_id=to_user_id)
        merged = await self._run(
            from_user_id, to_user_id, organization_id=organization_id, merged_by=merged_by, preview=False
        )
        merged.moved["agent_telemetry"] = telemetry
        for listener in self._listeners:
            await listener.merge_committed()
        await self._refresh_caches()
        logger.warning(
            "User merged by an operator: from=%s to=%s by=%s resumed=%s moved=%s",
            from_user_id,
            to_user_id,
            merged_by,
            merged.resumed,
            {table: count for table, count in merged.moved.items() if count},
        )
        return merged

    async def _is_sign_in_account(self, user_id: str) -> bool:
        try:
            account_id = uuid.UUID(user_id)
        except ValueError:
            return False
        async with self._uow:
            return await self._accounts.get(account_id) is not None

    async def _run(
        self, from_user_id: str, to_user_id: str, *, organization_id: uuid.UUID, merged_by: str | None, preview: bool
    ) -> UserMerge:
        async with self._uow:
            users = await self._users.lock_live([from_user_id, to_user_id], include_deleted=True)
            source, target = users.get(from_user_id), users.get(to_user_id)
            if target is None or target.deleted_at is not None:
                raise UserMergeRefusedError(f"User '{to_user_id}' does not exist or was deleted")
            if source is None or (source.deleted_at is not None and not _merged_into(source, to_user_id)):
                raise UserMergeRefusedError(f"User '{from_user_id}' does not exist or was deleted")
            resumed = source.deleted_at is not None
            # Its rows in that organization would move too, onto a user this one names.
            if await self._users.named_outside_organization(from_user_id, organization_id):
                raise UserMergeRefusedError(f"User '{from_user_id}' is also used in another organization")
            if source.reserved or source.reserved_tokens or source.reserved_requests:
                raise UserMergeRefusedError(
                    f"User '{from_user_id}' has a budget reservation in flight; retry once its requests finish"
                )
            shared = await self._users.shared_end_users(from_user_id, to_user_id)
            if shared:
                raise UserMergeRefusedError(
                    "Both users' service keys bill an end user with the same id: " + ", ".join(shared)
                )

            moved: dict[str, int] = {
                "end_users": (
                    await self._users.count_naming_user(from_user_id, column="parent_user_id")
                    if preview
                    else await self._users.reassign_user(from_user_id, to_user_id, column="parent_user_id")
                )
            }
            for listener in self._listeners:
                moved.update(await listener.user_merged(from_user_id, to_user_id, preview=preview))
            if not preview and not resumed:
                _retire(source, into=to_user_id, merged_by=merged_by)
                await self._users.flush()
        return UserMerge(
            from_user_id=from_user_id, to_user_id=to_user_id, moved=moved, preview=preview, resumed=resumed
        )


def _merged_into(user: User, to_user_id: str) -> bool:
    return (user.metadata_ or {}).get(MERGED_INTO_KEY) == to_user_id


def _retire(source: User, *, into: str, merged_by: str | None) -> None:
    """Soft-delete the merged user, recording where it went, when, and on whose word."""
    now = datetime.now(UTC)
    source.deleted_at = now
    source.metadata_ = {
        **(source.metadata_ or {}),
        MERGED_INTO_KEY: into,
        "merged_at": now.isoformat(),
        "merged_by": merged_by,
    }
