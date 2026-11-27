"""Add ``usage_logs.requested_model``, the model name the caller sent.

A row's ``model`` is what served it, after an alias or a routing policy
resolved the name, so the name the caller wrote is otherwise lost. Nullable
with no backfill: rows written before the column, and rows the gateway writes
for something other than a completion the caller named, read as not recorded.

Revision ID: c3e9a5f1b7d4
Revises: a70c702a1c51
Create Date: 2026-11-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c3e9a5f1b7d4"
down_revision: str | Sequence[str] | None = "a70c702a1c51"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"


def _has_column() -> bool:
    # Upstream's 02003653d88c adds the same column, and either revision may run first.
    return any(c["name"] == "requested_model" for c in sa.inspect(op.get_bind()).get_columns(_TABLE))


def upgrade() -> None:
    if not _has_column():
        op.add_column(_TABLE, sa.Column("requested_model", sa.String(), nullable=True))


def downgrade() -> None:
    if _has_column():
        with op.batch_alter_table(_TABLE) as batch_op:
            batch_op.drop_column("requested_model")
