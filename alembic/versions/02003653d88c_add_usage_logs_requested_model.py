"""Add requested_model to usage_logs.

A row's ``model`` is what served it, after an alias or a routing policy
resolved the name the caller sent, so a request sent under an alias could not
be told from one sent to its target. This keeps the name as sent.

Nullable with no backfill: an existing row's name was never recorded.
Unindexed until a read filters on it.

Revision ID: 02003653d88c
Revises: c7e1b9d4a260
Create Date: 2026-11-24 00:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "02003653d88c"
down_revision: str | Sequence[str] | None = "c7e1b9d4a260"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _has_column() -> bool:
    # Fork: c3e9a5f1b7d4 adds the same column on the fork's own chain, so either
    # revision may run first.
    return any(c["name"] == "requested_model" for c in sa.inspect(op.get_bind()).get_columns("usage_logs"))


def upgrade() -> None:
    """Upgrade schema."""
    if not _has_column():
        op.add_column("usage_logs", sa.Column("requested_model", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    if _has_column():
        with op.batch_alter_table("usage_logs") as batch_op:
            batch_op.drop_column("requested_model")
