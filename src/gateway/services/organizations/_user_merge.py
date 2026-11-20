"""Merging one billing user into another.

A ``users`` row is what keys, usage, budgets and per-user routing state bill
through, and two rows can name one person: an id typed by hand before sign-in
existed, and the row a sign-in account bills through under its identity's UUID.
A merge moves every row that names the source onto the target in one
transaction, adds the source's spend, token and request counters to the
target's, and retires the source with a note of where it went, so the person's
keys and history follow the account they sign in with. The target keeps its
own budget, access lists and blocked flag.
"""

import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Protocol

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeIntoItselfError, UserMergeRefusedError
from gateway.log_config import logger
from gateway.ports.telemetry_storage_port import TelemetryFilter, TelemetryStoragePort
from gateway.repositories.organizations import OrganizationRepositories
from gateway.repositories.tenancy import UserRepository

MERGED_INTO_KEY = "merged_into"
"""The key a retired user's metadata names the user it was merged into under."""


class UserMergeListener(Protocol):
    """Moves one domain's rows that name a billing user onto another, inside the caller's Unit of Work block.

    NOTE: an implementation must not commit or roll back. It names every table it
    moves rows in, with the count moved, a table with none included, and raises
    ``UserMergeRefusedError`` when its rows cannot move.
    """

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Stage moving this domain's rows from one user to the other; the rows moved per table."""
        ...


@dataclass(frozen=True)
class UserMerge:
    """What a merge moved, or on a preview would move."""

    from_user_id: str
    to_user_id: str
    moved: dict[str, int]
    """Rows per table, every table that names a user listed."""
    spend: Decimal
    tokens: int
    requests: int
    preview: bool


class _PreviewDone(Exception):
    """Ends a preview's block so that it rolls back, carrying what it found."""

    def __init__(self, merge: UserMerge) -> None:
        super().__init__()
        self.merge = merge


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
        self, from_user_id: str, to_user_id: str, *, merged_by: str | None, preview: bool = False
    ) -> UserMerge:
        """Move what names ``from_user_id`` onto ``to_user_id`` and retire it, or with ``preview`` say what would move.

        A preview runs the merge's own statements and rolls them back, so what it
        reports is what the merge does. A merge runs that preview first, then
        moves the source's agent telemetry, which a store outside this database
        cannot share the transaction, then the rest in one transaction. A merge
        refused or failed after the telemetry moved leaves it on the target,
        and running the merge again finishes it.

        Raises:
            UserMergeIntoItselfError: Both ids name one user.
            UserMergeRefusedError: The source is a sign-in account's own user, either user is gone, the source has a
                budget reservation in flight, or both users hold something only one of them may: a per-user alias,
                routing policy or provider endpoint of one name in one workspace, or an end user of one id.
        """
        if from_user_id == to_user_id:
            raise UserMergeIntoItselfError
        if await self._is_sign_in_account(from_user_id):
            raise UserMergeRefusedError(
                f"User '{from_user_id}' is the one a sign-in account bills through and cannot be retired; "
                "merge it the other way round"
            )
        telemetry = await self._telemetry.count(filters=TelemetryFilter(user_ids=(from_user_id,)))
        planned = await self._run(from_user_id, to_user_id, merged_by=merged_by, preview=True, telemetry=telemetry)
        if preview:
            return planned
        telemetry = await self._telemetry.reassign_user(from_user_id=from_user_id, to_user_id=to_user_id)
        merged = await self._run(from_user_id, to_user_id, merged_by=merged_by, preview=False, telemetry=telemetry)
        await self._refresh_caches()
        logger.warning(
            "User merged by an operator: from=%s to=%s by=%s moved=%s",
            from_user_id,
            to_user_id,
            merged_by,
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
        self, from_user_id: str, to_user_id: str, *, merged_by: str | None, preview: bool, telemetry: int
    ) -> UserMerge:
        try:
            async with self._uow:
                merge = await self._stage(from_user_id, to_user_id, merged_by=merged_by, preview=preview)
                merge.moved["agent_telemetry"] = telemetry
                if preview:
                    raise _PreviewDone(merge)
        except _PreviewDone as done:
            return done.merge
        return merge

    async def _stage(self, from_user_id: str, to_user_id: str, *, merged_by: str | None, preview: bool) -> UserMerge:
        users = await self._users.lock_live([from_user_id, to_user_id])
        source, target = users.get(from_user_id), users.get(to_user_id)
        if source is None or target is None:
            missing = from_user_id if source is None else to_user_id
            raise UserMergeRefusedError(f"User '{missing}' does not exist or was deleted")
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
            "end_users": await self._users.reassign_user(from_user_id, to_user_id, column="parent_user_id")
        }
        for listener in self._listeners:
            moved.update(await listener.user_merged(from_user_id, to_user_id))

        spend, tokens, requests = source.spend or Decimal(0), source.current_tokens, source.current_requests
        target.spend = (target.spend or Decimal(0)) + spend
        target.current_tokens += tokens
        target.current_requests += requests
        now = datetime.now(UTC)
        source.spend = Decimal(0)
        source.current_tokens = 0
        source.current_requests = 0
        source.deleted_at = now
        source.metadata_ = {
            **(source.metadata_ or {}),
            MERGED_INTO_KEY: to_user_id,
            "merged_at": now.isoformat(),
            "merged_by": merged_by,
        }
        await self._users.flush()
        return UserMerge(
            from_user_id=from_user_id,
            to_user_id=to_user_id,
            moved=moved,
            spend=spend,
            tokens=tokens,
            requests=requests,
            preview=preview,
        )
