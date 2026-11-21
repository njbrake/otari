"""Data access for ``saved_views``, the only module that constructs or queries it. Flushes, never commits."""

import uuid
from collections.abc import Collection
from typing import Any, Never

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.elements import ColumnElement

from gateway.core.sql import dialect_name
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.saved_views_exceptions import SavedViewNameTakenError
from gateway.models.saved_views import SavedView
from gateway.repositories.base_repository import BaseRepository

# The most views one menu read returns: every view of the caller's own, and the shared ones past them.
_LIST_LIMIT = 300


def _visible_to(user_id: uuid.UUID) -> ColumnElement[bool]:
    """A view its owner saved, or one shared with the workspace."""
    return or_(SavedView.user_id == user_id, SavedView.shared.is_(True))


class SavedViewRepository(BaseRepository[SavedView, Never, Never]):
    """Query and stage saved views.

    The owner and workspace a written view names must exist, because every
    refusal of the write is reported as a name already taken.
    """

    def __init__(self, db: AsyncSession | UnitOfWork) -> None:
        super().__init__(db, SavedView)

    async def add(
        self, *, user_id: uuid.UUID, workspace_id: uuid.UUID, page: str, name: str, query: str, shared: bool
    ) -> SavedView:
        """Stage a new view and return it with its generated values.

        Raises:
            SavedViewNameTakenError: its owner already has a view of this name on this page.
        """
        view = SavedView(user_id=user_id, workspace_id=workspace_id, page=page, name=name, query=query, shared=shared)
        self.db.add(view)
        try:
            await self.db.flush()
        except IntegrityError:
            raise SavedViewNameTakenError(name) from None
        await self.db.refresh(view)
        return view

    async def update(self, db_obj: SavedView, obj_in: dict[str, Any]) -> SavedView:
        """Stage changes to a view, refusing a rename onto another of its owner's names."""
        name = obj_in.get("name", db_obj.name)
        try:
            return await super().update(db_obj, obj_in)
        except IntegrityError:
            raise SavedViewNameTakenError(name) from None

    async def lock_owned(self, *, workspace_id: uuid.UUID, page: str, user_id: uuid.UUID) -> None:
        """Serialize this person's saves on this page until the transaction ends, so two cannot both take the last slot.

        A transaction-scoped advisory lock on PostgreSQL, keyed on the owner and
        page rather than a row, since what it guards is a count. SQLite runs one
        writer at a time, so it takes none.
        """
        if dialect_name(self.db) != "postgresql":
            return
        key = f"saved_views:{workspace_id}:{page}:{user_id}"
        await self.db.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(key, 0))))

    async def count_owned(self, *, workspace_id: uuid.UUID, page: str, user_id: uuid.UUID) -> int:
        """Count the views this person saved on this page of this workspace."""
        result = await self.db.execute(
            select(func.count())
            .select_from(SavedView)
            .where(SavedView.workspace_id == workspace_id, SavedView.page == page, SavedView.user_id == user_id)
        )
        return result.scalar_one()

    async def list_visible(self, *, workspace_id: uuid.UUID, page: str, user_id: uuid.UUID) -> list[SavedView]:
        """The views this person may open on a page: their own first, then the shared ones, each by name."""
        result = await self.db.execute(
            select(SavedView)
            .where(SavedView.workspace_id == workspace_id, SavedView.page == page, _visible_to(user_id))
            .order_by(SavedView.user_id != user_id, func.lower(SavedView.name), SavedView.id)
            .limit(_LIST_LIMIT)
        )
        return list(result.scalars().all())

    async def get_visible(self, *, view_id: uuid.UUID, workspace_id: uuid.UUID, user_id: uuid.UUID) -> SavedView | None:
        """One view this person may open in this workspace, or None."""
        result = await self.db.execute(
            select(SavedView).where(
                SavedView.id == view_id, SavedView.workspace_id == workspace_id, _visible_to(user_id)
            )
        )
        return result.scalar_one_or_none()

    async def remove_owned_in(self, user_id: uuid.UUID, workspace_ids: Collection[uuid.UUID]) -> None:
        """Stage the removal of every view this person saved in these workspaces."""
        if not workspace_ids:
            return
        await self.db.execute(
            delete(SavedView).where(SavedView.user_id == user_id, SavedView.workspace_id.in_(list(workspace_ids)))
        )
        await self.db.flush()

    async def count_owned_by(self, user_id: uuid.UUID) -> int:
        """Count every view this person saved, on any page of any workspace."""
        result = await self.db.execute(select(func.count()).select_from(SavedView).where(SavedView.user_id == user_id))
        return result.scalar_one()

    async def owned_outside(self, user_id: uuid.UUID, workspace_ids: Collection[uuid.UUID]) -> bool:
        """Whether this person saved a view in a workspace other than these."""
        result = await self.db.execute(
            select(SavedView.id)
            .where(SavedView.user_id == user_id, SavedView.workspace_id.not_in(list(workspace_ids)))
            .limit(1)
        )
        return result.first() is not None

    async def names_owned_by_both(self, first: uuid.UUID, second: uuid.UUID) -> list[str]:
        """The view names both people saved on one page of one workspace, ignoring case."""
        other = aliased(SavedView)
        result = await self.db.execute(
            select(SavedView.name)
            .join(
                other,
                (other.workspace_id == SavedView.workspace_id)
                & (other.page == SavedView.page)
                & (func.lower(other.name) == func.lower(SavedView.name)),
            )
            .where(SavedView.user_id == first, other.user_id == second)
        )
        return sorted(set(result.scalars().all()))

    async def reassign_owner(self, from_user_id: uuid.UUID, to_user_id: uuid.UUID) -> int:
        """Stage moving every view one person saved onto another; the number moved."""
        result = await self.db.execute(
            update(SavedView).where(SavedView.user_id == from_user_id).values(user_id=to_user_id)
        )
        await self.db.flush()
        return int(getattr(result, "rowcount", 0) or 0)
