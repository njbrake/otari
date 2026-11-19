"""Join the fork's migration chain with upstream's after the 2026-11-07 sync.

The fork's chain through c7e9a1b3d5f2 is applied in production, so the upstream
migrations that followed the last join are joined here rather than re-parented.

Revision ID: d8f1b4e6a2c9
Revises: c7e9a1b3d5f2, a7d3c9e1f5b2
Create Date: 2026-11-07
"""

from collections.abc import Sequence

revision: str = "d8f1b4e6a2c9"
down_revision: str | Sequence[str] | None = ("c7e9a1b3d5f2", "a7d3c9e1f5b2")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""


def downgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""
