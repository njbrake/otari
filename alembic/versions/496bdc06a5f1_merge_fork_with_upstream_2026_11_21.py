"""Join the fork's chain with upstream's agent telemetry user barriers.

Both heads are kept as they are: the fork's revisions are applied in
production and are not re-parented.

Revision ID: 496bdc06a5f1
Revises: f3b7d1a9c5e2, b4d6f8a0c2e5
Create Date: 2026-11-21
"""

from collections.abc import Sequence

revision: str = "496bdc06a5f1"
down_revision: str | Sequence[str] | None = ("f3b7d1a9c5e2", "b4d6f8a0c2e5")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change: this revision only joins the two heads."""


def downgrade() -> None:
    """Nothing to change: this revision only joins the two heads."""
