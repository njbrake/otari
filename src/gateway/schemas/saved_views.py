"""Request and response models of the saved-views domain."""

from datetime import datetime
from typing import Annotated
from urllib.parse import parse_qsl

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints

from gateway.models.saved_views import MAX_VIEW_NAME_LENGTH, MAX_VIEW_QUERY_LENGTH, SavedViewPage

# Trimmed, so "Slow" and "Slow " are one name and a blank one is refused.
ViewName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_VIEW_NAME_LENGTH)]


def _query_string(value: str) -> str:
    """Refuse anything but a query string of ``key=value`` pairs, so a view can only filter the page it opens."""
    if value.startswith(("/", "?", "&")) or "://" in value or any(char == "#" or char.isspace() for char in value):
        raise ValueError("must be a query string, without a leading '?', a path, a fragment or whitespace")
    if value:
        try:
            parse_qsl(value, keep_blank_values=True, strict_parsing=True)
        except ValueError:
            raise ValueError("must be key=value pairs joined by '&'") from None
    return value


ViewQuery = Annotated[
    str,
    Field(
        max_length=MAX_VIEW_QUERY_LENGTH,
        description="The page's query string, without the leading '?'. Only the keys the page keeps in a view.",
    ),
    AfterValidator(_query_string),
]


class SavedViewCreate(BaseModel):
    """A view to save: the page it belongs to, its name, and the query string it applies."""

    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "example": {"page": "requests", "name": "Failures this week", "query": "range=7d&status=error"}
        },
    )

    page: SavedViewPage
    name: ViewName
    query: ViewQuery
    shared: bool = Field(default=False, description="Offer it to every member of the workspace.")


class SavedViewUpdate(BaseModel):
    """What to change on one of the caller's views. A field left out, or sent as null, is left as it is."""

    model_config = ConfigDict(extra="forbid")

    name: ViewName | None = None
    query: ViewQuery | None = None
    shared: bool | None = None


class SavedViewPublic(BaseModel):
    """A view as the caller's menu lists it: built in, their own, or shared with the workspace."""

    id: str = Field(description="The saved view's id, or `built-in:<slug>` for one the page offers itself.")
    page: SavedViewPage
    name: str
    query: str
    built_in: bool = Field(description="Offered by the page itself, not stored; it cannot be changed or deleted.")
    shared: bool
    is_mine: bool = Field(description="The caller saved it.")
    owner_name: str | None = Field(
        description="Who saved it; null for a built-in one and for one whose owner deleted their account."
    )
    owner_left: bool = Field(
        description=(
            "Shared, and its owner left the workspace or deleted their account, so the workspace's managers keep it."
        )
    )
    can_edit: bool = Field(description="The caller may rename it or save the page's current filters over it.")
    can_delete: bool
    updated_at: datetime | None = Field(description="When it was last saved; null for a built-in one.")


class SavedViewsPublic(BaseModel):
    """A page's views in a workspace: the built-in ones, then the caller's own, then those shared with it."""

    data: list[SavedViewPublic]
    can_share: bool = Field(description="The caller manages the workspace, so may share a view with it.")
