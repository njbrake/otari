"""Join the fork's migration chain with upstream's after the 2026-10-01 sync.

The fork's join revision 504ade1408a7 is already applied in production, so the
upstream migrations that followed its parent are joined here rather than
re-parented.

Revision ID: 8db806b917ee
Revises: 504ade1408a7, c4e8a2f6b1d3
Create Date: 2026-10-01
"""

from collections.abc import Sequence

revision: str = "8db806b917ee"
down_revision: str | Sequence[str] | None = ("504ade1408a7", "c4e8a2f6b1d3")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""


def downgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""
