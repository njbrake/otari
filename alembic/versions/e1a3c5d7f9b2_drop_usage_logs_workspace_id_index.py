"""Drop the single-column workspace index on usage rows.

``ix_usage_logs_workspace_id_timestamp`` leads with ``workspace_id``, so it
answers every lookup the single-column index did, the foreign key's check
when a workspace is deleted included, and the single-column one only cost a
write on every usage insert.

Dropped ``CONCURRENTLY`` on PostgreSQL, outside the chain's transaction, so
the drop does not wait behind, or block, writes to a busy ``usage_logs``.

Revision ID: e1a3c5d7f9b2
Revises: a3d5f7b9c1e2
Create Date: 2026-10-13
"""

from collections.abc import Sequence

from alembic import op

revision: str = "e1a3c5d7f9b2"
down_revision: str | Sequence[str] | None = "a3d5f7b9c1e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"
_INDEX = "ix_usage_logs_workspace_id"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.create_index(_INDEX, _TABLE, ["workspace_id"], postgresql_concurrently=True, if_not_exists=True)
