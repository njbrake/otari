"""Keep whether a usage row was deployment-paid, and its deployment-paid cost, on the rollups.

``deployment_paid`` joins the keys an hour's rollups are grouped by, so the
filter on it is served from them, and ``deployment_paid_cost`` joins the
measures, so a summary's deployment-paid total is the one its rows give. The
rollups built before them are deleted and every hour with usage is marked, so
the background refresh rebuilds them; a marked hour is read from its rows
meanwhile.

On PostgreSQL ``deployment_paid`` is NOT NULL with no default. A gateway still
on the previous version during a rolling deploy rebuilds hours without it, so
its refresh fails and rolls back, leaving its marks for this version's refresh.

Revision ID: b4b297ed92e7
Revises: d8b2f4a6c0e9
Create Date: 2026-11-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b4b297ed92e7"
down_revision: str | Sequence[str] | None = "d8b2f4a6c0e9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "usage_rollups"
_HOUR = "date_trunc('hour', {} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        # SQLite never reads the rollups, and adds a NOT NULL column only with a default.
        op.add_column(_TABLE, sa.Column("deployment_paid", sa.Boolean(), nullable=False, server_default=sa.false()))
        op.add_column(_TABLE, sa.Column("deployment_paid_cost", sa.Numeric(), nullable=True))
        return
    op.execute(f"DELETE FROM {_TABLE}")
    op.add_column(_TABLE, sa.Column("deployment_paid", sa.Boolean(), nullable=False))
    op.add_column(_TABLE, sa.Column("deployment_paid_cost", sa.Numeric(), nullable=True))
    # Every hour from the first row's to the last's, read off the timestamp index.
    op.execute(
        "INSERT INTO usage_rollup_dirty_hours (hour) "
        f"SELECT generate_series({_HOUR.format('first_at')}, {_HOUR.format('last_at')}, interval '1 hour') "
        'FROM (SELECT min("timestamp") AS first_at, max("timestamp") AS last_at FROM usage_logs) AS bounds'
    )


def downgrade() -> None:
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_column("deployment_paid_cost")
        batch_op.drop_column("deployment_paid")
