"""Add ``saved_views``: a dashboard page's filters, kept under a name.

One row per view, owned by a sign-in identity in one workspace and optionally
shared with it. Removed with its owner or its workspace.

Revision ID: f3b7d1a9c5e2
Revises: a1f3c5e7b9d2
Create Date: 2026-11-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f3b7d1a9c5e2"
down_revision: str | Sequence[str] | None = "a1f3c5e7b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "saved_views"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspace.id", ondelete="CASCADE"), nullable=False),
        sa.Column("page", sa.String(16), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("query", sa.String(2000), nullable=False),
        sa.Column("shared", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index(
        "uq_saved_views_owner_name",
        _TABLE,
        ["workspace_id", "page", "user_id", sa.text("lower(name)")],
        unique=True,
    )
    op.create_index("ix_saved_views_user_id", _TABLE, ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_saved_views_user_id", table_name=_TABLE)
    op.drop_index("uq_saved_views_owner_name", table_name=_TABLE)
    op.drop_table(_TABLE)
