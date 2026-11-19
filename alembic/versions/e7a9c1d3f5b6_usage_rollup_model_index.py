"""Index the hourly usage rollups by model.

A model page's 30-day usage of each offering otherwise scans every rollup row of
the organization's month to keep one model's.

Built ``CONCURRENTLY`` on PostgreSQL, outside the chain's transaction, as in
``c5e7a9b1d3f4``.

Revision ID: e7a9c1d3f5b6
Revises: d6f8b0c2e4a5
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "e7a9c1d3f5b6"
down_revision: str | Sequence[str] | None = "d6f8b0c2e4a5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_rollups"
_NAME = "ix_usage_rollups_model_hour"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        if bind.dialect.name == "postgresql":
            invalid = bind.execute(
                sa.text("SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"), {"name": _NAME}
            ).scalar()
            if invalid:
                op.drop_index(_NAME, table_name=_TABLE, postgresql_concurrently=True)
        op.create_index(_NAME, _TABLE, ["model", "hour"], postgresql_concurrently=True, if_not_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        op.drop_index(_NAME, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)
