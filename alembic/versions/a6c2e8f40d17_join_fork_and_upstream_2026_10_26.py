"""Join the fork's migration chain with upstream's after the 2026-10-26 sync.

The fork's chain through f1ff207ffb6c is applied in production, so the upstream
migrations that followed it are joined here rather than re-parented.

Revision ID: a6c2e8f40d17
Revises: f1ff207ffb6c, bea0cc9abb34
Create Date: 2026-10-26
"""

from collections.abc import Sequence

revision: str = "a6c2e8f40d17"
down_revision: str | Sequence[str] | None = ("f1ff207ffb6c", "bea0cc9abb34")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""


def downgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""
