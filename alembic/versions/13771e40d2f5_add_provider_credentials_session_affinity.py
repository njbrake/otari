"""Let a stored provider opt into session affinity.

A ``providers:`` entry in config.yml can set ``session_affinity``; a provider
stored through the dashboard had nowhere to keep it. Existing rows default to
off, which is what they meant before the column existed.

The column goes through ``batch_alter_table`` with ``copy_from`` so that SQLite,
which rebuilds the table to drop a column, works from the declared shape rather
than a reflection of it.

Revision ID: 13771e40d2f5
Revises: b2d4f6a8c0e2
Create Date: 2026-09-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "13771e40d2f5"
down_revision: str | Sequence[str] | None = "b2d4f6a8c0e2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _provider_credentials(*, with_session_affinity: bool) -> sa.Table:
    columns = [
        sa.Column("instance", sa.String(), nullable=False),
        sa.Column("provider_type", sa.String(), nullable=True),
        sa.Column("api_base", sa.String(), nullable=True),
        sa.Column("encrypted_api_key", sa.String(), nullable=True),
        sa.Column("last4", sa.String(), nullable=True),
        sa.Column("client_args", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    ]
    if with_session_affinity:
        columns.append(sa.Column("session_affinity", sa.Boolean(), nullable=False, server_default=sa.false()))
    return sa.Table("provider_credentials", sa.MetaData(), *columns, sa.PrimaryKeyConstraint("instance"))


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table(
        "provider_credentials", copy_from=_provider_credentials(with_session_affinity=False)
    ) as batch_op:
        batch_op.add_column(sa.Column("session_affinity", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    """Downgrade schema."""
    with op.batch_alter_table(
        "provider_credentials", copy_from=_provider_credentials(with_session_affinity=True)
    ) as batch_op:
        batch_op.drop_column("session_affinity")
