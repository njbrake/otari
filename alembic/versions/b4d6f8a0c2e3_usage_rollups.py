"""Sum usage rows by hour, and mark the hours a write to them changed.

``usage_rollups`` holds an hour's usage rows summed per combination of the keys
the usage reads filter and group by, and ``usage_rollup_dirty_hours`` names the
hours whose rows changed since. On PostgreSQL a statement-level trigger on
``usage_logs`` marks the hours of every row an insert, update or delete touched,
in the same transaction as the change, and the gateway's refresh rebuilds a
marked hour from the rows. The trigger knows nothing of what an hour's sums
are, so how a row is counted is defined once, in the gateway.

Every hour that already has rows is marked here, after the trigger is in place
and in the same transaction, so the refresh builds the history and no write
lands between the two unmarked. SQLite gets the tables alone: the reads there
never use them.

Revision ID: b4d6f8a0c2e3
Revises: e1a3c5d7f9b2
Create Date: 2026-10-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b4d6f8a0c2e3"
down_revision: str | Sequence[str] | None = "e1a3c5d7f9b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_HOUR = "date_trunc('hour', \"timestamp\" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"
_TOOLS = ("web_search", "web_fetch", "code_execution")

# One function per event, because a statement-level trigger sees only the
# transition tables its own event declares.
_MARKERS = {
    "INSERT": f"INSERT INTO usage_rollup_dirty_hours (hour) SELECT DISTINCT {_HOUR} FROM new_rows;",
    "UPDATE": (
        f"INSERT INTO usage_rollup_dirty_hours (hour) SELECT {_HOUR} FROM new_rows UNION SELECT {_HOUR} FROM old_rows;"
    ),
    "DELETE": f"INSERT INTO usage_rollup_dirty_hours (hour) SELECT DISTINCT {_HOUR} FROM old_rows;",
}
_REFERENCING = {
    "INSERT": "NEW TABLE AS new_rows",
    "UPDATE": "NEW TABLE AS new_rows OLD TABLE AS old_rows",
    "DELETE": "OLD TABLE AS old_rows",
}


def _name(event: str) -> str:
    return f"usage_rollup_mark_{event.lower()}"


def upgrade() -> None:
    op.create_table(
        "usage_rollups",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True, autoincrement=True),
        sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column("requested_model", sa.String(), nullable=True),
        sa.Column("provider", sa.String(), nullable=True),
        sa.Column("endpoint", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=True),
        sa.Column("api_key_id", sa.String(), nullable=True),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("source_label", sa.String(), nullable=True),
        sa.Column("policy_name", sa.String(), nullable=True),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=True),
        sa.Column("needs_pricing", sa.Boolean(), nullable=False),
        sa.Column("rows", sa.BigInteger(), nullable=False),
        sa.Column("first_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_at", sa.DateTime(timezone=True), nullable=False),
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
                sa.Column(f"{tool}_cost", sa.Double(), nullable=True),
                sa.Column(f"{tool}_rows", sa.BigInteger(), nullable=False),
            )
        ),
    )
    op.create_index("ix_usage_rollups_hour", "usage_rollups", ["hour"])
    op.create_index("ix_usage_rollups_workspace_id_hour", "usage_rollups", ["workspace_id", "hour"])
    op.create_table(
        "usage_rollup_dirty_hours",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), primary_key=True, autoincrement=True),
        sa.Column("hour", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_usage_rollup_dirty_hours_hour", "usage_rollup_dirty_hours", ["hour"])

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
    op.execute(f"INSERT INTO usage_rollup_dirty_hours (hour) SELECT {_HOUR} FROM usage_logs GROUP BY 1")


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for event in _MARKERS:
            op.execute(f"DROP TRIGGER IF EXISTS {_name(event)} ON usage_logs")
            op.execute(f"DROP FUNCTION IF EXISTS {_name(event)}()")
    op.drop_index("ix_usage_rollup_dirty_hours_hour", table_name="usage_rollup_dirty_hours")
    op.drop_table("usage_rollup_dirty_hours")
    op.drop_index("ix_usage_rollups_workspace_id_hour", table_name="usage_rollups")
    op.drop_index("ix_usage_rollups_hour", table_name="usage_rollups")
    op.drop_table("usage_rollups")
