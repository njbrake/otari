"""Keep every latency an hour's usage rows recorded on its rollups.

Two integer arrays per rollup row, the distinct latencies its rows took and how
many took each, so a percentile over a window is read from the rollups and is
the one its rows give. The rollups built before them lack the arrays, so every
hour with usage is marked and rebuilt in the background; a marked hour is read
from its rows meanwhile, so no read sees a rollup without them.

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
    array = postgresql.ARRAY(sa.Integer()).with_variant(sa.JSON(), "sqlite")
    for column in _COLUMNS:
        op.add_column("usage_rollups", sa.Column(column, array, nullable=True))
    if op.get_bind().dialect.name != "postgresql":
        return
    # Every hour from the first row's to the last's, read off the timestamp index.
    op.execute(
        "INSERT INTO usage_rollup_dirty_hours (hour) "
        f"SELECT generate_series({_HOUR.format('first_at')}, {_HOUR.format('last_at')}, interval '1 hour') "
        'FROM (SELECT min("timestamp") AS first_at, max("timestamp") AS last_at FROM usage_logs) AS bounds'
    )


def downgrade() -> None:
    for column in _COLUMNS:
        op.drop_column("usage_rollups", column)
