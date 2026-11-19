"""Join the fork's migration chain with upstream's after the 2026-10-16 sync.

The fork's chain through e7a9c1d3f5b6 is applied in production, so the upstream
migrations that followed it are joined here rather than re-parented.

Revision ID: f1ff207ffb6c
Revises: e7a9c1d3f5b6, e4410dfaf0db
Create Date: 2026-10-16
"""

from collections.abc import Sequence

revision: str = "f1ff207ffb6c"
down_revision: str | Sequence[str] | None = ("e7a9c1d3f5b6", "e4410dfaf0db")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""


def downgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""
