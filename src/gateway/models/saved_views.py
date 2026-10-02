"""Saved views: a named filter state for a dashboard page, kept on the server.

A view is the page's query string under a name (window, filters, sort, grouping),
so opening one is navigating to it and a shared link needs nothing stored. What
the table adds over a bookmark is that it follows the person to another browser
and, when shared, is offered to everyone in the workspace.

Owned by the tenancy identity (``user.id``) and its workspace, and cascaded from
both, for the reason ``models/playground.py`` gives: this is the page's own
memory, with no ledger to preserve, so it leaves with the account or the
workspace.
"""

import uuid
from typing import Literal

from sqlalchemy import Index, text
from sqlmodel import Field, SQLModel

from gateway.models.base import CreatedAtMixin, PrimaryKeyMixin, UpdatedAtMixin

# The pages that keep saved views. Closed, so a view cannot be filed under a page
# that will never read it.
SavedViewPage = Literal["activity"]

MAX_VIEW_NAME_LENGTH = 80
# A view's query string. Well past what the Activity page's filters serialize to.
MAX_VIEW_QUERY_LENGTH = 2000
# How many views one person may keep on one page of one workspace. A menu, not an
# archive: past this the list stops being something to pick from.
MAX_VIEWS_PER_PAGE = 50


class SavedView(SQLModel, PrimaryKeyMixin, CreatedAtMixin, UpdatedAtMixin, table=True):
    """One saved view, owned by the identity that saved it, in one workspace."""

    __tablename__ = "saved_view"
    __table_args__ = (
        # One name per person per page, ignoring case as the menu's order does, so
        # "Failures this week" means one thing in their own menu. Two people may each
        # share a view of the same name; the menu names who shared it. Its leading
        # columns also serve the menu's query (a page's views in one workspace), the
        # owner count and the workspace foreign key, so none of them needs an index
        # of its own.
        Index("uq_saved_view_owner_lower_name", "workspace_id", "page", "user_id", text("lower(name)"), unique=True),
    )

    user_id: uuid.UUID = Field(foreign_key="user.id", ondelete="CASCADE", index=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", ondelete="CASCADE")
    page: str = Field(max_length=40)
    name: str = Field(max_length=MAX_VIEW_NAME_LENGTH)
    query: str = Field(max_length=MAX_VIEW_QUERY_LENGTH)
    # Offered to every member of the workspace, not only its owner. Only someone
    # who manages the workspace may share one.
    shared: bool = False
