"""Index usage rows by workspace and time.

The dashboard's usage reads scoped to a workspace or an organization filter
``workspace_id`` and a timestamp window and order newest first. The existing
``(workspace_id, source, status, timestamp)`` index serves that shape only
when source and status are both pinned, so those reads fell back to the
single-column workspace index and read the workspace's whole history.

On PostgreSQL the index is built ``CONCURRENTLY``, outside the chain's
transaction, so a large ``usage_logs`` keeps taking writes while it builds.
SQLite ignores the option. The build still holds startup until it finishes, so
an operator with a large table may build it beforehand under the same name;
``IF NOT EXISTS`` then makes this revision a no-op. A concurrent build that
failed or was cancelled leaves an invalid index under that name, which
``IF NOT EXISTS`` would keep, so an invalid one is dropped and built again.

Revision ID: a3d5f7b9c1e2
Revises: fc179a3f122a
Create Date: 2026-10-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a3d5f7b9c1e2"
down_revision: str | Sequence[str] | None = "fc179a3f122a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"
_INDEX = "ix_usage_logs_workspace_id_timestamp"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        if bind.dialect.name == "postgresql":
            invalid = bind.execute(
                sa.text("SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"), {"name": _INDEX}
            ).scalar()
            if invalid:
                op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True)
        op.create_index(_INDEX, _TABLE, ["workspace_id", "timestamp"], postgresql_concurrently=True, if_not_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)
