"""Merge one request-plane user into another.

A ``users`` row is what keys, usage, budgets and per-user routing state bill
through, and two rows can name one person: an id typed by hand before sign-in
existed, and the attribution row a sign-in account mints under its identity's
UUID. Merging moves everything that references the source onto the target in
one transaction, adds the source's counters to the target's, and retires the
source, so the person's keys and history follow the account they sign in with.

Telemetry is moved in the ``agent_telemetry`` table; a telemetry store bound to
something other than this database keeps its rows under the source id.
"""

from datetime import UTC, datetime
from decimal import Decimal

from gateway.core.unit_of_work import UnitOfWork
from gateway.log_config import logger
from gateway.models.users import User
from gateway.repositories.tenancy import UserMergeRepository


class UserMergeError(Exception):
    """A merge refused before anything was written."""


class SameUserMergeError(UserMergeError):
    def __init__(self) -> None:
        super().__init__("A user cannot be merged into itself")


class SignInAccountSourceError(UserMergeError):
    def __init__(self, user_id: str) -> None:
        super().__init__(
            f"User '{user_id}' belongs to a sign-in account and cannot be retired; merge it the other way round"
        )


class ReservationInFlightError(UserMergeError):
    def __init__(self, user_id: str) -> None:
        super().__init__(f"User '{user_id}' has a budget reservation in flight; retry once its requests finish")


class NameCollisionError(UserMergeError):
    def __init__(self, names: list[str]) -> None:
        super().__init__(
            "Both users have a per-user alias or routing policy with the same name in one workspace: "
            + ", ".join(sorted(names))
        )


async def merge_users(uow: UnitOfWork, repo: UserMergeRepository, *, source: User, target: User) -> dict[str, int]:
    """Move everything referencing ``source`` onto ``target``, retire ``source``, and commit.

    Returns the rows moved per table. The target keeps its own budget, model
    access and blocked flag; the spend, token and request counters are added,
    so a budget enforced on the target counts what the source already spent.
    """
    if source.user_id == target.user_id:
        raise SameUserMergeError
    if await repo.is_identity_attribution(source.user_id):
        raise SignInAccountSourceError(source.user_id)
    if (
        source.reserved
        or source.reserved_tokens
        or source.reserved_requests
        or await repo.has_active_reservation(source.user_id)
    ):
        raise ReservationInFlightError(source.user_id)
    collisions = await repo.named_collisions(source.user_id, target.user_id)
    if collisions:
        raise NameCollisionError(collisions)

    async with uow:
        moved = await repo.reassign(source.user_id, target.user_id)
        target.spend = (target.spend or Decimal(0)) + (source.spend or Decimal(0))
        target.current_tokens += source.current_tokens
        target.current_requests += source.current_requests
        source.spend = Decimal(0)
        source.current_tokens = 0
        source.current_requests = 0
        source.deleted_at = datetime.now(UTC)
        source.metadata_ = {**(source.metadata_ or {}), "merged_into": target.user_id}
    await repo.reload(target)

    logger.info("Merged user %s into %s: %s", source.user_id, target.user_id, moved)
    return moved
