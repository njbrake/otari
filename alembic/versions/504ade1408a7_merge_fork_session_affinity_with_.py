"""Merge the fork's session-affinity column with upstream's migration chain.

The fork's migration was applied to a live database before upstream's chain
grew past their shared parent, so it is joined here rather than re-parented:
re-parenting would leave that database marked past migrations it never ran.

Revision ID: 504ade1408a7
Revises: 13771e40d2f5, a9c4e7b2d5f8
Create Date: 2026-09-28 23:56:37.256471
"""

from collections.abc import Sequence

revision: str = "504ade1408a7"
down_revision: str | Sequence[str] | None = ("13771e40d2f5", "a9c4e7b2d5f8")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""


def downgrade() -> None:
    """Nothing to change; this revision only joins the two branches."""
