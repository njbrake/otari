"""Request and response models of the saved-views domain."""

import uuid
from datetime import datetime
from typing import Annotated, Self, cast

from pydantic import AfterValidator, BaseModel, Field, StringConstraints

from gateway.models.saved_views import MAX_VIEW_NAME_LENGTH, MAX_VIEW_QUERY_LENGTH, SavedView, SavedViewPage

# Trimmed, so "Slow" and "Slow " are one name and a blank one is refused.
ViewName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_VIEW_NAME_LENGTH)]


def _query_string(value: str) -> str:
    """Refuse anything but a page's own query string, so a view can only filter the page it opens."""
    if value.startswith(("/", "?")) or "://" in value or any(char == "#" or char.isspace() for char in value):
        raise ValueError("must be a query string, without a leading '?', a path, a fragment or whitespace")
    return value


ViewQuery = Annotated[str, Field(max_length=MAX_VIEW_QUERY_LENGTH), AfterValidator(_query_string)]


class SavedViewCreate(BaseModel):
    """A view to save: the page it belongs to, its name, and the query string it applies."""

    page: SavedViewPage
    name: ViewName
    query: ViewQuery
    shared: bool = False


class SavedViewUpdate(BaseModel):
    """What to change. A field left out, or sent as null, is left as it is."""

    name: ViewName | None = None
    query: ViewQuery | None = None
    shared: bool | None = None


class SavedViewPublic(BaseModel):
    """A saved view as its menu lists it."""

    id: uuid.UUID
    page: SavedViewPage
    name: str
    query: str
    shared: bool
    user_id: uuid.UUID
    # Who saved it, for a shared view in someone else's menu. Null when the
    # identity has no name set.
    owner_name: str | None
    # Whether the caller saved it, which is what lets them rename or delete it.
    is_mine: bool
    created_at: datetime
    updated_at: datetime | None

    @classmethod
    def from_model(cls, view: SavedView, *, owner_name: str | None, caller: uuid.UUID) -> Self:
        """Build the public view from its row, as ``caller`` sees it."""
        return cls(
            id=view.id,
            # Written from a SavedViewPage, so a stored value is always one.
            page=cast(SavedViewPage, view.page),
            name=view.name,
            query=view.query,
            shared=view.shared,
            user_id=view.user_id,
            owner_name=owner_name,
            is_mine=view.user_id == caller,
            created_at=view.created_at,
            updated_at=view.updated_at,
        )


class SavedViewsPublic(BaseModel):
    """A page's menu: the caller's own views first, then the workspace's shared ones, each by name.

    ``data`` is the page ``skip`` and ``limit`` asked for; ``count`` is how many
    the caller may open in all.
    """

    data: list[SavedViewPublic]
    count: int
