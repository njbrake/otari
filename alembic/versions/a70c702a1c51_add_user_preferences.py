"""Add ``user_preferences``: what a signed-in person chose about how the dashboard looks.

One row per identity and key, holding the dashboard's own JSON document (a
table's column widths and hidden columns, today). Removed with its identity.

Revision ID: a70c702a1c51
Revises: d2f4a6c8e0b1
Create Date: 2026-11-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a70c702a1c51"
down_revision: str | Sequence[str] | None = "d2f4a6c8e0b1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "user_preferences"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("user.id", ondelete="CASCADE"), nullable=False),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        # Leads with user_id, so it is also that column's index.
        sa.UniqueConstraint("user_id", "key", name="uq_user_preferences_user_key"),
    )


def downgrade() -> None:
    op.drop_table(_TABLE)
