"""Join the fork's migration chain with upstream's after the 2026-10-12 sync.

The fork's chain through 8db806b917ee is applied in production, so the upstream
migrations that followed it are joined here rather than re-parented.

Revision ID: fc179a3f122a
Revises: 8db806b917ee, 12c2e4745129
Create Date: 2026-10-12
"""

from collections.abc import Sequence

revision: str = "fc179a3f122a"
down_revision: str | Sequence[str] | None = ("8db806b917ee", "12c2e4745129")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""


def downgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""
