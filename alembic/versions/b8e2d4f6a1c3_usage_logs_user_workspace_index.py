"""Index usage rows by user and workspace.

The users list scopes each user to an organization by whether it has usage in
one of that organization's workspaces. Without an index on both columns the
planner reads ``usage_logs`` in full for each user with none, which on a large
table made ``GET /users`` outlast the dashboard's request timeout.

Built ``CONCURRENTLY`` with the same handling of a pre-built or invalid index
as ``a3d5f7b9c1e2``.

Revision ID: b8e2d4f6a1c3
Revises: d8f1b4e6a2c9
Create Date: 2026-11-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8e2d4f6a1c3"
down_revision: str | Sequence[str] | None = "d8f1b4e6a2c9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"
_INDEX = "ix_usage_logs_user_id_workspace_id"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        if bind.dialect.name == "postgresql":
            invalid = bind.execute(
                sa.text("SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"), {"name": _INDEX}
            ).scalar()
            if invalid:
                op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True)
        op.create_index(_INDEX, _TABLE, ["user_id", "workspace_id"], postgresql_concurrently=True, if_not_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)
