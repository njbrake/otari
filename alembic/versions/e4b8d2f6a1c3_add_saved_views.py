"""Add saved views: a dashboard page's named filter states, per person or shared.

One table, ``saved_view``, owned by a tenancy identity and a workspace and
cascaded from both (see ``models/saved_views.py``). A person's view names are
unique per page of a workspace, and that constraint's leading columns also serve
the menu's query and the workspace foreign key.

Revision ID: e4b8d2f6a1c3
Revises: c7e3a1f5b9d2
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e4b8d2f6a1c3"
down_revision: str | Sequence[str] | None = "c7e3a1f5b9d2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "saved_view"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("page", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("query", sa.String(length=2000), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "page", "user_id", "name", name="uq_saved_view_owner_name"),
    )
    op.create_index(op.f("ix_saved_view_user_id"), _TABLE, ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_saved_view_user_id"), table_name=_TABLE)
    op.drop_table(_TABLE)
