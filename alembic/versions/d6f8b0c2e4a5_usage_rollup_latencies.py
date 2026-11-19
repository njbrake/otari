"""Keep every latency an hour's usage rows recorded on its rollups.

Two integer arrays per rollup row, the distinct latencies its rows took and how
many took each, so a percentile over a window is read from the rollups and is
the one its rows give. The rollups built before them are deleted and every hour
with usage is marked, so the background refresh rebuilds them; a marked hour is
read from its rows meanwhile.

On PostgreSQL the columns are NOT NULL with no default. A gateway still on the
previous version during a rolling deploy rebuilds hours without them, so its
refresh now fails and rolls back, leaving its marks for this version's refresh,
rather than storing hours whose latencies a percentile would silently miss.

Revision ID: d6f8b0c2e4a5
Revises: c5e7a9b1d3f4
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d6f8b0c2e4a5"
down_revision: str | Sequence[str] | None = "c5e7a9b1d3f4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_COLUMNS = ("latency_values", "latency_counts")
_HOUR = "date_trunc('hour', {} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        # SQLite never reads the rollups, and adds a NOT NULL column only with a default.
        for column in _COLUMNS:
            op.add_column("usage_rollups", sa.Column(column, sa.JSON(), nullable=True))
        return
    op.execute("DELETE FROM usage_rollups")
    for column in _COLUMNS:
        op.add_column("usage_rollups", sa.Column(column, postgresql.ARRAY(sa.Integer()), nullable=False))
    # Every hour from the first row's to the last's, read off the timestamp index.
    op.execute(
        "INSERT INTO usage_rollup_dirty_hours (hour) "
        f"SELECT generate_series({_HOUR.format('first_at')}, {_HOUR.format('last_at')}, interval '1 hour') "
        'FROM (SELECT min("timestamp") AS first_at, max("timestamp") AS last_at FROM usage_logs) AS bounds'
    )


def downgrade() -> None:
    for column in _COLUMNS:
        op.drop_column("usage_rollups", column)
