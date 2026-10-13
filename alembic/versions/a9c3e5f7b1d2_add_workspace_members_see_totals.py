"""Let a workspace's managers choose whether members see its totals.

One boolean on ``workspace``. Every existing workspace reads ``true``, so its
members start seeing the workspace's aggregate usage and its budget's dollars;
a manager can turn that off.

Revision ID: a9c3e5f7b1d2
Revises: b4d6f8a0c2e3
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a9c3e5f7b1d2"
down_revision: str | Sequence[str] | None = "b4d6f8a0c2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "workspace",
        sa.Column("members_see_workspace_totals", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("workspace", "members_see_workspace_totals")
