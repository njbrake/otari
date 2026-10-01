"""Record the model name the caller sent, and the request id they were given.

``usage_logs.model`` holds the model that served, so a request that named an
alias (``fast``) or a routing policy read the same as one that named its target
directly. ``requested_model`` keeps the name as sent.

The ``Otari-Request-ID`` a caller receives was never stored, so the id in a
client's log could not be matched to its usage row. ``request_id`` keeps it,
indexed because it is looked up on its own.

Both nullable with no backfill: neither was recorded before, so older rows have
nothing to recover. Plain ``ADD COLUMN`` needs no table rebuild on SQLite.

On PostgreSQL the index is built ``CONCURRENTLY``, outside the chain's
transaction, so a large ``usage_logs`` keeps taking writes while it builds.
SQLite ignores the option.

Revision ID: c7e3a1f5b9d2
Revises: 504ade1408a7
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e3a1f5b9d2"
down_revision: str | Sequence[str] | None = "504ade1408a7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"
_REQUEST_ID_INDEX = "ix_usage_logs_request_id"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column("requested_model", sa.String(), nullable=True))
    op.add_column(_TABLE, sa.Column("request_id", sa.String(), nullable=True))
    with op.get_context().autocommit_block():
        op.create_index(_REQUEST_ID_INDEX, _TABLE, ["request_id"], postgresql_concurrently=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(_REQUEST_ID_INDEX, table_name=_TABLE, postgresql_concurrently=True)
    op.drop_column(_TABLE, "request_id")
    op.drop_column(_TABLE, "requested_model")
