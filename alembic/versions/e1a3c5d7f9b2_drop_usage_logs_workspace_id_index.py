"""Drop the single-column workspace index on usage rows.

``ix_usage_logs_workspace_id_timestamp`` leads with ``workspace_id``, so it
answers every lookup the single-column index did, the foreign key's check
when a workspace is deleted included, and the single-column one only cost a
write on every usage insert.

Dropped ``CONCURRENTLY`` on PostgreSQL, outside the chain's transaction, so
the drop does not wait behind, or block, writes to a busy ``usage_logs``.
A concurrent rebuild on downgrade that failed or was cancelled leaves an
invalid index under the name, which ``IF NOT EXISTS`` would keep, so an
invalid one is dropped and built again, as in ``a3d5f7b9c1e2``.

Revision ID: e1a3c5d7f9b2
Revises: a3d5f7b9c1e2
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
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
        bind = op.get_bind()
        if bind.dialect.name == "postgresql":
            invalid = bind.execute(
                sa.text("SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"), {"name": _INDEX}
            ).scalar()
            if invalid:
                op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True)
        op.create_index(_INDEX, _TABLE, ["workspace_id"], postgresql_concurrently=True, if_not_exists=True)
