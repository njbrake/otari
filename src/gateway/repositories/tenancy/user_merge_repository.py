"""Data access for merging one request-plane user into another."""

import uuid
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlmodel import col

from gateway.models.api_keys import APIKey
from gateway.models.budgets import BudgetReservation, BudgetResetLog
from gateway.models.files import FileObject
from gateway.models.inference import BatchRecord
from gateway.models.providers import ModelAlias
from gateway.models.routing import RouterPreference, RoutingMemory, RoutingPolicy
from gateway.models.tenancy import User as Identity
from gateway.models.tools import SandboxContainer
from gateway.models.usage import AgentTelemetry, UsageLog
from gateway.models.users import User

# Every table with a foreign key to ``users.user_id``. A new one belongs here, or
# a merge leaves its rows on a retired user.
REFERENCING: tuple[Any, ...] = (
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
    SandboxContainer,
)
# Unique on (workspace_id, name, user_id), so a same-named row on both users
# would collide once moved.
_NAMED_PER_USER: tuple[Any, ...] = (ModelAlias, RoutingPolicy)


class UserMergeRepository:
    """The reads and bulk writes a user merge needs. Flushes nothing and never commits."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def is_identity_attribution(self, user_id: str) -> bool:
        """Whether ``user_id`` is the attribution row of a sign-in account (its identity's UUID)."""
        try:
            identity_id = uuid.UUID(user_id)
        except ValueError:
            return False
        found = await self.db.execute(select(col(Identity.id)).where(col(Identity.id) == identity_id))
        return found.scalar_one_or_none() is not None

    async def has_active_reservation(self, user_id: str) -> bool:
        active = await self.db.execute(
            select(func.count())
            .select_from(BudgetReservation)
            .where(BudgetReservation.user_id == user_id, BudgetReservation.status == "active")
        )
        return active.scalar_one() > 0

    async def named_collisions(self, source_id: str, target_id: str) -> list[str]:
        """Names of per-user aliases and policies both users hold in one workspace."""
        names: list[str] = []
        for model in _NAMED_PER_USER:
            on_target = aliased(model)
            rows = await self.db.execute(
                select(model.name)
                .join(on_target, and_(on_target.workspace_id == model.workspace_id, on_target.name == model.name))
                .where(model.user_id == source_id, on_target.user_id == target_id)
            )
            names.extend(rows.scalars().all())
        return names

    async def reassign(self, source_id: str, target_id: str) -> dict[str, int]:
        """Point every referencing row at ``target_id``; returns the rows moved per table."""
        moved: dict[str, int] = {}
        for model in REFERENCING:
            result = await self.db.execute(
                update(model)
                .where(model.user_id == source_id)
                .values(user_id=target_id)
                .execution_options(synchronize_session=False)
            )
            moved[model.__tablename__] = getattr(result, "rowcount", 0) or 0
        return moved

    async def reload(self, user: User) -> None:
        await self.db.refresh(user)
