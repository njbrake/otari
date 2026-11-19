"""Let a hosted provider opt into session affinity.

A Deployment providers row could set ``session_affinity`` (13771e40d2f5), and
upstream moves those rows onto hosted providers, so the hosted provider holds
the flag too. Off for every existing row.

Revision ID: b3d5f7a9c1e4
Revises: a6c2e8f40d17
Create Date: 2026-10-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3d5f7a9c1e4"
down_revision: str | Sequence[str] | None = "a6c2e8f40d17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "hosted_providers",
        sa.Column("session_affinity", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("hosted_providers", "session_affinity")
