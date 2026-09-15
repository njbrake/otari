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

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import col

from gateway.log_config import logger
from gateway.models.entities import (
    AgentTelemetry,
    APIKey,
    BatchRecord,
    BudgetReservation,
    BudgetResetLog,
    FileObject,
    ModelAlias,
    RouterPreference,
    RoutingMemory,
    RoutingPolicy,
    UsageLog,
    User,
)
from gateway.models.tenancy import User as Identity
from gateway.services.alias_service import refresh_alias_cache
from gateway.services.policy_store import refresh_policy_cache

# Every table with a foreign key to ``users.user_id``. A new one belongs here, or
# a merge leaves its rows on a retired user.
_REFERENCING: tuple[Any, ...] = (
    APIKey,
    UsageLog,
    AgentTelemetry,
    FileObject,
    BatchRecord,
    RoutingMemory,
    RouterPreference,
    BudgetResetLog,
    BudgetReservation,
    ModelAlias,
    RoutingPolicy,
)
# Unique on (workspace_id, name, user_id), so a same-named row on both users
# would collide once moved.
_NAMED_PER_USER: tuple[Any, ...] = (ModelAlias, RoutingPolicy)


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


async def merge_users(db: AsyncSession, *, source: User, target: User) -> dict[str, int]:
    """Move everything referencing ``source`` onto ``target``, retire ``source``, and commit.

    Returns the rows moved per table. The target keeps its own budget, model
    access and blocked flag; the spend, token and request counters are added,
    so a budget enforced on the target counts what the source already spent.
    """
    if source.user_id == target.user_id:
        raise SameUserMergeError
    if await _belongs_to_identity(db, source.user_id):
        raise SignInAccountSourceError(source.user_id)
    if await _has_reservation_in_flight(db, source):
        raise ReservationInFlightError(source.user_id)
    collisions = await _named_collisions(db, source.user_id, target.user_id)
    if collisions:
        raise NameCollisionError(collisions)

    moved: dict[str, int] = {}
    try:
        for model in _REFERENCING:
            result = await db.execute(
                update(model)
                .where(model.user_id == source.user_id)
                .values(user_id=target.user_id)
                .execution_options(synchronize_session=False)
            )
            moved[model.__tablename__] = getattr(result, "rowcount", 0) or 0

        target.spend = (target.spend or Decimal(0)) + (source.spend or Decimal(0))
        target.current_tokens += source.current_tokens
        target.current_requests += source.current_requests
        source.spend = Decimal(0)
        source.current_tokens = 0
        source.current_requests = 0
        source.deleted_at = datetime.now(UTC)
        source.metadata_ = {**(source.metadata_ or {}), "merged_into": target.user_id}
        await db.commit()
    except SQLAlchemyError:
        await db.rollback()
        raise
    await db.refresh(target)

    logger.info("Merged user %s into %s: %s", source.user_id, target.user_id, moved)
    await _refresh_caches(db, moved)
    return moved


async def _belongs_to_identity(db: AsyncSession, user_id: str) -> bool:
    """Whether ``user_id`` is the attribution row of a sign-in account (its identity's UUID)."""
    try:
        identity_id = uuid.UUID(user_id)
    except ValueError:
        return False
    found = await db.execute(select(col(Identity.id)).where(col(Identity.id) == identity_id))
    return found.scalar_one_or_none() is not None


async def _has_reservation_in_flight(db: AsyncSession, user: User) -> bool:
    if user.reserved or user.reserved_tokens or user.reserved_requests:
        return True
    active = await db.execute(
        select(func.count())
        .select_from(BudgetReservation)
        .where(BudgetReservation.user_id == user.user_id, BudgetReservation.status == "active")
    )
    return active.scalar_one() > 0


async def _named_collisions(db: AsyncSession, source_id: str, target_id: str) -> list[str]:
    names: list[str] = []
    for model in _NAMED_PER_USER:
        on_target = aliased(model)
        rows = await db.execute(
            select(model.name)
            .join(on_target, and_(on_target.workspace_id == model.workspace_id, on_target.name == model.name))
            .where(model.user_id == source_id, on_target.user_id == target_id)
        )
        names.extend(rows.scalars().all())
    return names


async def _refresh_caches(db: AsyncSession, moved: dict[str, int]) -> None:
    """Reload the per-user alias and policy caches the move changed.

    The merge is committed, so a refresh failure is logged rather than raised;
    other workers converge on their next background refresh.
    """
    try:
        if moved.get(ModelAlias.__tablename__):
            await refresh_alias_cache(db)
        if moved.get(RoutingPolicy.__tablename__):
            await refresh_policy_cache(db)
    except SQLAlchemyError:
        logger.warning("Cache refresh failed after merging users; converges on the next background refresh")
