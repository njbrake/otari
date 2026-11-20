"""Add ``usage_logs.requested_model``, the model name the caller sent.

A row's ``model`` is what served it, after an alias or a routing policy
resolved the name, so the name the caller wrote is otherwise lost. Nullable
with no backfill: rows written before the column, and rows the gateway writes
for something other than a completion the caller named, read as not recorded.

Revision ID: e5a7c9b1d3f6
Revises: a70c702a1c51
Create Date: 2026-11-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e5a7c9b1d3f6"
down_revision: str | Sequence[str] | None = "a70c702a1c51"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("requested_model", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column("requested_model")
