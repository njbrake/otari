"""Index ``usage_logs.requested_model``.

The routing traffic read matches each policy and alias name against the name
the caller sent, so without an index it reads every row in the window.

Built ``CONCURRENTLY`` with the same handling of a pre-built or invalid index
as ``b8e2d4f6a1c3``.

Revision ID: a1f3c5e7b9d2
Revises: c3e9a5f1b7d4
Create Date: 2026-11-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a1f3c5e7b9d2"
down_revision: str | Sequence[str] | None = "c3e9a5f1b7d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_logs"
_INDEX = "ix_usage_logs_requested_model"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        if bind.dialect.name == "postgresql":
            invalid = bind.execute(
                sa.text("SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"), {"name": _INDEX}
            ).scalar()
            if invalid:
                op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True)
        op.create_index(_INDEX, _TABLE, ["requested_model"], postgresql_concurrently=True, if_not_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(_INDEX, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)
