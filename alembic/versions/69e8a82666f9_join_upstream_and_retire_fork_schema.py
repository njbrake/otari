"""Join the fork's chain with upstream's and retire the fork's own schema.

The fork realigned with upstream on 2026-11-19 and keeps only a few of its
changes. This joins the two heads and removes what the fork's discarded
features created, so the migrated schema matches the models again:

- the hourly usage rollups: the three statement triggers on ``usage_logs`` and
  their functions, which would otherwise mark dirty hours on every usage write
  with nothing left to drain them, and the two rollup tables;
- saved views;
- the workspace switches for members (``members_see_workspace_totals``,
  ``members_create_policies``);
- session affinity on hosted and stored providers;
- ``usage_logs.requested_model`` and ``usage_logs.request_id`` with its index.

Kept: ``ix_usage_logs_workspace_id_timestamp`` (which also stands in for the
single-column workspace index the fork dropped), ``ix_usage_logs_user_id_workspace_id``
and ``billing_meters`` as jsonb.

The downgrade recreates the retired objects empty, by replaying the fork
revisions that made them, so the chain still round-trips; their data is a
backup's to restore, not this chain's.

Revision ID: 69e8a82666f9
Revises: b8e2d4f6a1c3, e8c2a4f6b1d3
Create Date: 2026-11-19
"""

import importlib.util
from collections.abc import Sequence
from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision: str = "69e8a82666f9"
down_revision: str | Sequence[str] | None = ("b8e2d4f6a1c3", "e8c2a4f6b1d3")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ROLLUP_EVENTS = ("insert", "update", "delete")
# The fork revisions whose objects this retires, in chain order, for the downgrade.
_RETIRED_REVISIONS = (
    "c7e3a1f5b9d2",
    "e4b8d2f6a1c3",
    "f1a3c5e7b9d2",
    "b4d6f8a0c2e3",
    "a9c3e5f7b1d2",
    "c5e7a9b1d3f4",
    "d6f8b0c2e4a5",
    "e7a9c1d3f5b6",
    "b3d5f7a9c1e4",
    "c7e9a1b3d5f2",
)
_DROPPED_COLUMNS = (
    ("workspace", "members_see_workspace_totals"),
    ("workspace", "members_create_policies"),
    ("hosted_providers", "session_affinity"),
    ("provider_credentials", "session_affinity"),
    ("usage_logs", "requested_model"),
    ("usage_logs", "request_id"),
)


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for event in _ROLLUP_EVENTS:
            op.execute(f"DROP TRIGGER IF EXISTS usage_rollup_mark_{event} ON usage_logs")
            op.execute(f"DROP FUNCTION IF EXISTS usage_rollup_mark_{event}()")
    op.drop_table("usage_rollup_dirty_hours", if_exists=True)
    op.drop_table("usage_rollups", if_exists=True)
    op.drop_table("saved_view", if_exists=True)
    op.drop_index("ix_usage_logs_request_id", table_name="usage_logs", if_exists=True)
    for table, column in _DROPPED_COLUMNS:
        with op.batch_alter_table(table) as batch_op:
            batch_op.drop_column(column)


def _replay_upgrade(revision_id: str) -> None:
    (path,) = Path(__file__).parent.glob(f"{revision_id}_*.py")
    spec = importlib.util.spec_from_file_location(f"_retired_{revision_id}", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.upgrade()


def downgrade() -> None:
    # Added directly rather than replayed: 13771e40d2f5 rebuilds the table from
    # the columns it had then, which on SQLite would drop every column added since.
    with op.batch_alter_table("provider_credentials") as batch_op:
        batch_op.add_column(sa.Column("session_affinity", sa.Boolean(), nullable=False, server_default=sa.false()))
    for revision_id in _RETIRED_REVISIONS:
        _replay_upgrade(revision_id)
