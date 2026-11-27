"""Join the fork's chain with upstream's MCP shared account disconnects.

Both heads are kept as they are: the fork's revisions are applied in
production and are not re-parented. The fork's ``usage_logs.requested_model``
revision is renamed to ``c3e9a5f1b7d4`` because upstream reused its old ID; it
is not a head anywhere, so no ``alembic_version`` row names it.

Revision ID: d8b2f4a6c0e9
Revises: b3f7d9e1a5c2, ab0af3310ec6
Create Date: 2026-11-27
"""

from collections.abc import Sequence

revision: str = "d8b2f4a6c0e9"
down_revision: str | Sequence[str] | None = ("b3f7d9e1a5c2", "ab0af3310ec6")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change: this revision only joins the two heads."""


def downgrade() -> None:
    """Nothing to change: this revision only joins the two heads."""
