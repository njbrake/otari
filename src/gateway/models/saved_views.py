"""Tables the saved-views domain owns: a dashboard page's filters, kept under a name."""

import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, Index, String, Uuid, false, func, text
from sqlalchemy.orm import Mapped, mapped_column

from gateway.models.base import Base, UtcDateTime

MAX_VIEW_NAME_LENGTH = 80
# A view's query string. Well past what either page's filters serialize to.
MAX_VIEW_QUERY_LENGTH = 2000
# How many views one person keeps on one page of one workspace: a menu, not an archive.
MAX_VIEWS_PER_PAGE = 50


class SavedViewPage(StrEnum):
    """The pages that keep saved views. Closed, so a view cannot be filed under a page that never reads it."""

    SESSIONS = "sessions"
    REQUESTS = "requests"


# The query keys each page reads as its view: which rows, and in what order. Where
# the reader is (the page number, the open row) and a window dragged on the chart
# are not part of a view, so their keys are not here.
_SHARED_KEYS = ("scope", "range", "q", "status", "model", "user_id", "api_key_id", "sort", "order")
VIEW_QUERY_KEYS: dict[SavedViewPage, frozenset[str]] = {
    SavedViewPage.SESSIONS: frozenset(_SHARED_KEYS),
    SavedViewPage.REQUESTS: frozenset(
        (
            *_SHARED_KEYS,
            "exclude_status",
            "status_code",
            "exclude_model",
            "exclude_user_id",
            "exclude_api_key_id",
            "priced",
            "source",
            "exclude_source",
            "source_label",
            "endpoint",
            "provider",
            "tool",
            "policy_name",
            "exclude_policy_name",
            "routed",
            "tokens_gt",
            "cost_gt",
            "latency_ms_gt",
            "channel",
            "is_null",
            "recovered",
            "group",
        )
    ),
}


class SavedView(Base):
    """One saved view: a page's query string under a name, owned by the identity that saved it in one workspace.

    It goes with its workspace. A private one goes with its owner too, while a
    shared one outlives them, ownerless once their account is deleted, and the
    workspace's managers keep it from then on.
    """

    __tablename__ = "saved_views"
    __table_args__ = (
        # One name per person per page, ignoring case. Its leading columns also serve
        # the menu's read (a page's views in one workspace) and the workspace's
        # foreign key, so neither needs an index of its own.
        Index("uq_saved_views_owner_name", "workspace_id", "page", "user_id", text("lower(name)"), unique=True),
        Index("ix_saved_views_user_id", "user_id"),
        # Only a shared view may outlive its owner: an ownerless private view is
        # one nobody can see or delete.
        CheckConstraint("user_id IS NOT NULL OR shared", name="ck_saved_views_owned_or_shared"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    # Null only on a shared view whose owner deleted their account.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("user.id", ondelete="SET NULL", name="fk_saved_views_user"), nullable=True
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("workspace.id", ondelete="CASCADE"), nullable=False
    )
    page: Mapped[str] = mapped_column(String(16), nullable=False)
    name: Mapped[str] = mapped_column(String(MAX_VIEW_NAME_LENGTH), nullable=False)
    query: Mapped[str] = mapped_column(String(MAX_VIEW_QUERY_LENGTH), nullable=False)
    # Offered to every member of the workspace, not only its owner.
    shared: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(
        UtcDateTime(), nullable=False, default=lambda: datetime.now(UTC), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        UtcDateTime(),
        nullable=False,
        default=lambda: datetime.now(UTC),
        onupdate=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
