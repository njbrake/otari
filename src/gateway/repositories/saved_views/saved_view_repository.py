import uuid
from typing import Any, Never

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql.elements import ColumnElement
from sqlmodel import col

from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.saved_views_exceptions import SavedViewNameTakenError
from gateway.models.saved_views import SavedView
from gateway.models.tenancy import User
from gateway.repositories.base_repository import BaseRepository


def _visible_to(user_id: uuid.UUID) -> ColumnElement[bool]:
    """A view its owner saved, or one shared with the workspace."""
    return or_(col(SavedView.user_id) == user_id, col(SavedView.shared).is_(True))


class SavedViewRepository(BaseRepository[SavedView, Never, Never]):
    """Query and stage saved views in the open block of a Unit of Work.

    The owner and workspace a written view names must exist, because every
    refusal of the write is reported as a name already taken.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, SavedView)

    async def add(self, view: SavedView) -> SavedView:
        """Stage a new view and return it with its generated values.

        Raises:
            SavedViewNameTakenError: its owner already has a view of this name on this page.
        """
        # Read before the flush: a refused flush expires the row's attributes.
        name = view.name
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

    async def count_owned(self, *, workspace_id: uuid.UUID, page: str, user_id: uuid.UUID) -> int:
        """Count the views this person saved on this page of this workspace."""
        return await self._count(workspace_id, page, col(SavedView.user_id) == user_id)

    async def count_visible(self, *, workspace_id: uuid.UUID, page: str, user_id: uuid.UUID) -> int:
        """Count the views this person may open on this page of this workspace."""
        return await self._count(workspace_id, page, _visible_to(user_id))

    async def _count(self, workspace_id: uuid.UUID, page: str, whose: ColumnElement[bool]) -> int:
        result = await self.db.execute(
            select(func.count())
            .select_from(SavedView)
            .where(col(SavedView.workspace_id) == workspace_id, col(SavedView.page) == page, whose)
        )
        return result.scalar_one()

    async def list_visible(
        self, *, workspace_id: uuid.UUID, page: str, user_id: uuid.UUID, skip: int, limit: int
    ) -> list[tuple[SavedView, str | None]]:
        """Return a page of the views this person may open on a page, each with its owner's name.

        Their own first, then the shared ones, each by name, so the first page
        holds every view of their own.
        """
        result = await self.db.execute(
            select(SavedView, col(User.full_name))
            .join(User, col(User.id) == col(SavedView.user_id))
            .where(
                col(SavedView.workspace_id) == workspace_id,
                col(SavedView.page) == page,
                _visible_to(user_id),
            )
            .order_by(col(SavedView.user_id) != user_id, func.lower(col(SavedView.name)), col(SavedView.id))
            .offset(skip)
            .limit(limit)
        )
        return list(result.tuples().all())

    async def get_visible(self, *, view_id: uuid.UUID, workspace_id: uuid.UUID, user_id: uuid.UUID) -> SavedView | None:
        """Return one view this person may open in this workspace, or None."""
        result = await self.db.execute(
            select(SavedView).where(
                col(SavedView.id) == view_id,
                col(SavedView.workspace_id) == workspace_id,
                _visible_to(user_id),
            )
        )
        return result.scalar_one_or_none()
