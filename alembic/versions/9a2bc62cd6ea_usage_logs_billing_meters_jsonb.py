"""Store usage_logs.billing_meters as jsonb on PostgreSQL.

The usage analytics sum billed token meters out of this column on every row of
the window, several times per summary. A ``json`` value is kept as text and
re-parsed on each extraction, which was most of what those scans cost; ``jsonb``
is stored parsed. Values and their extraction semantics are unchanged.

SQLite has no ``jsonb`` and keeps the column as it is.

The retype rewrites the table under an exclusive lock, so writes to
``usage_logs`` wait for it (about a second per 150k rows).

Revision ID: 9a2bc62cd6ea
Revises: 13771e40d2f5
Create Date: 2026-09-28
"""

from collections.abc import Sequence

from alembic import op

revision: str = "9a2bc62cd6ea"
down_revision: str | Sequence[str] | None = "13771e40d2f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _retype(to: str) -> None:
    if op.get_bind().dialect.name != "postgresql":
        return
    op.execute(f"ALTER TABLE usage_logs ALTER COLUMN billing_meters TYPE {to} USING billing_meters::{to}")


def upgrade() -> None:
    """Upgrade schema."""
    _retype("jsonb")


def downgrade() -> None:
    """Downgrade schema."""
    _retype("json")
