"""Index the hourly usage rollups by user and by API key.

A read narrowed to one user, or to the keys one person owns (the Overview's own
scope), otherwise scans every rollup row of its window to keep its own few.

Built ``CONCURRENTLY`` on PostgreSQL, outside the chain's transaction, so the
refresh that writes the rollups is not held up; an invalid index left by a
failed build is dropped and built again, as in ``a3d5f7b9c1e2``.

Revision ID: c5e7a9b1d3f4
Revises: b4d6f8a0c2e3
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5e7a9b1d3f4"
down_revision: str | Sequence[str] | None = "b4d6f8a0c2e3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_rollups"
_INDEXES = {"ix_usage_rollups_user_id_hour": ["user_id", "hour"], "ix_usage_rollups_api_key_id_hour": ["api_key_id", "hour"]}


def upgrade() -> None:
    with op.get_context().autocommit_block():
        bind = op.get_bind()
        for name, columns in _INDEXES.items():
            if bind.dialect.name == "postgresql":
                invalid = bind.execute(
                    sa.text("SELECT NOT indisvalid FROM pg_index WHERE indexrelid = to_regclass(:name)"), {"name": name}
                ).scalar()
                if invalid:
                    op.drop_index(name, table_name=_TABLE, postgresql_concurrently=True)
            op.create_index(name, _TABLE, columns, postgresql_concurrently=True, if_not_exists=True)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for name in _INDEXES:
            op.drop_index(name, table_name=_TABLE, postgresql_concurrently=True, if_exists=True)
