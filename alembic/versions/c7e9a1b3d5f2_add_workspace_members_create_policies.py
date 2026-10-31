"""Let a workspace's managers choose whether members may create their own routing policies.

One boolean on ``workspace``. Every existing workspace reads ``true``: a member
may create a policy that applies only to their own requests unless a manager
turns it off.

Revision ID: c7e9a1b3d5f2
Revises: b3d5f7a9c1e4
Create Date: 2026-10-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e9a1b3d5f2"
down_revision: str | Sequence[str] | None = "b3d5f7a9c1e4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "workspace",
        sa.Column("members_create_policies", sa.Boolean(), nullable=False, server_default=sa.true()),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("workspace", "members_create_policies")
