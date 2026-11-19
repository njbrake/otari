"""Sum usage rows by hour, and mark the hours a write to them changed.

``usage_rollups`` holds an hour's usage rows summed per combination of the keys
the usage reads filter and group by, and ``usage_rollup_dirty_hours`` names the
hours whose rows changed since. On PostgreSQL a statement-level trigger on
``usage_logs`` marks the hours of every row an insert, update or delete touched,
in the same transaction as the change, and the gateway's refresh rebuilds a
marked hour from the rows. The trigger knows nothing of what an hour's sums are,
so how a row is counted is defined once, in the gateway.

Every hour from the first row's to the last's is marked here, after the triggers
are in place and in the same transaction, so the refresh builds the history and
no write lands between the two unmarked. Only the bounds are read, off the
timestamp index, so the lock the triggers take on ``usage_logs`` is held briefly.
SQLite gets the tables alone: the reads there never use them.

Revision ID: d2f4a6c8e0b1
Revises: 69e8a82666f9
Create Date: 2026-11-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d2f4a6c8e0b1"
down_revision: str | Sequence[str] | None = "69e8a82666f9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ROLLUPS = "usage_rollups"
_DIRTY_HOURS = "usage_rollup_dirty_hours"
_HOUR = "date_trunc('hour', {column} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
_ROW_HOUR = _HOUR.format(column='"timestamp"')
_TOOLS = ("web_search", "web_fetch", "code_execution")

# One function per event, because a statement-level trigger sees only the
# transition tables its own event declares.
_MARKERS = {
    "INSERT": f"INSERT INTO usage_rollup_dirty_hours (hour) SELECT DISTINCT {_ROW_HOUR} FROM new_rows;",
    "UPDATE": (
        f"INSERT INTO usage_rollup_dirty_hours (hour) "
        f"SELECT {_ROW_HOUR} FROM new_rows UNION SELECT {_ROW_HOUR} FROM old_rows;"
    ),
    "DELETE": f"INSERT INTO usage_rollup_dirty_hours (hour) SELECT DISTINCT {_ROW_HOUR} FROM old_rows;",
}
_REFERENCING = {
    "INSERT": "NEW TABLE AS new_rows",
    "UPDATE": "NEW TABLE AS new_rows OLD TABLE AS old_rows",
    "DELETE": "OLD TABLE AS old_rows",
}


def _name(event: str) -> str:
    return f"usage_rollup_mark_{event.lower()}"


def _id() -> sa.Column[int]:
    return sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True, autoincrement=True)


def upgrade() -> None:
    op.create_table(
        _ROLLUPS,
        _id(),
        sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=True),
        sa.Column("endpoint", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=True),
        sa.Column("api_key_id", sa.String(), nullable=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("source_label", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("counts_toward_budget", sa.Boolean(), nullable=False),
        sa.Column("needs_pricing", sa.Boolean(), nullable=False),
        sa.Column("rows", sa.BigInteger(), nullable=False),
        sa.Column("cost", sa.Numeric(), nullable=True),
        sa.Column("prompt_tokens", sa.BigInteger(), nullable=True),
        sa.Column("completion_tokens", sa.BigInteger(), nullable=True),
        sa.Column("total_tokens", sa.BigInteger(), nullable=True),
        sa.Column("cache_read_tokens", sa.BigInteger(), nullable=True),
        sa.Column("cache_write_tokens", sa.BigInteger(), nullable=True),
        sa.Column("cache_write_1h_tokens", sa.BigInteger(), nullable=True),
        sa.Column("reasoning_tokens", sa.BigInteger(), nullable=True),
        sa.Column("billed_input_tokens", sa.BigInteger(), nullable=False),
        sa.Column("billed_output_tokens", sa.BigInteger(), nullable=False),
        sa.Column("billed_cache_read_tokens", sa.BigInteger(), nullable=False),
        sa.Column("billed_cache_write_tokens", sa.BigInteger(), nullable=False),
        sa.Column("latency_ms", sa.BigInteger(), nullable=True),
        sa.Column("latency_count", sa.BigInteger(), nullable=False),
        *(
            column
            for tool in _TOOLS
            for column in (
                sa.Column(f"{tool}_calls", sa.BigInteger(), nullable=True),
                sa.Column(f"{tool}_errors", sa.BigInteger(), nullable=True),
                sa.Column(f"{tool}_cost", sa.Numeric(), nullable=True),
                sa.Column(f"{tool}_rows", sa.BigInteger(), nullable=False),
            )
        ),
    )
    op.create_index("ix_usage_rollups_hour", _ROLLUPS, ["hour"])
    op.create_index("ix_usage_rollups_workspace_id_hour", _ROLLUPS, ["workspace_id", "hour"])
    op.create_table(
        _DIRTY_HOURS,
        _id(),
        sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_usage_rollup_dirty_hours_hour", _DIRTY_HOURS, ["hour"])

    if op.get_bind().dialect.name != "postgresql":
        return
    for event, statement in _MARKERS.items():
        op.execute(
            f"CREATE FUNCTION {_name(event)}() RETURNS trigger LANGUAGE plpgsql AS $$ "
            f"BEGIN {statement} RETURN NULL; END $$"
        )
        op.execute(
            f"CREATE TRIGGER {_name(event)} AFTER {event} ON usage_logs "
            f"REFERENCING {_REFERENCING[event]} FOR EACH STATEMENT EXECUTE FUNCTION {_name(event)}()"
        )
    # An hour with no rows builds to nothing, so marking the whole span is safe.
    first, last = (_HOUR.format(column=bound) for bound in ("first_at", "last_at"))
    op.execute(
        "INSERT INTO usage_rollup_dirty_hours (hour) "
        f"SELECT generate_series({first}, {last}, interval '1 hour') "
        'FROM (SELECT min("timestamp") AS first_at, max("timestamp") AS last_at FROM usage_logs) AS bounds'
    )


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for event in _MARKERS:
            op.execute(f"DROP TRIGGER IF EXISTS {_name(event)} ON usage_logs")
            op.execute(f"DROP FUNCTION IF EXISTS {_name(event)}()")
    op.drop_index("ix_usage_rollup_dirty_hours_hour", table_name=_DIRTY_HOURS)
    op.drop_table(_DIRTY_HOURS)
    op.drop_index("ix_usage_rollups_workspace_id_hour", table_name=_ROLLUPS)
    op.drop_index("ix_usage_rollups_hour", table_name=_ROLLUPS)
    op.drop_table(_ROLLUPS)
