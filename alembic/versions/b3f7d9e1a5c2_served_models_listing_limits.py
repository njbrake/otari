"""Keep the limits a model listing that is no engine's gives.

Another Otari lists each model with ``context_window`` and ``max_output_tokens``,
and OpenRouter with ``context_length`` and ``top_provider.max_completion_tokens``.
Those rows are recorded under the ``listing`` engine, and the output limit gets
a column of its own.

Revision ID: b3f7d9e1a5c2
Revises: c7e3a9f1d5b8
Create Date: 2026-11-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b3f7d9e1a5c2"
down_revision: str | Sequence[str] | None = "c7e3a9f1d5b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "served_models"
_CHECK = "ck_served_models_engine"


def _engines(*engines: str) -> sa.TextClause:
    return sa.text("engine IN (" + ", ".join(f"'{engine}'" for engine in engines) + ")")


def upgrade() -> None:
    """Upgrade schema."""
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.add_column(sa.Column("max_output_tokens", sa.Integer(), nullable=True))
        batch_op.drop_constraint(_CHECK, type_="check")
        batch_op.create_check_constraint(_CHECK, _engines("vllm", "sglang", "listing"))


def downgrade() -> None:
    """Downgrade schema."""
    op.execute(sa.text(f"DELETE FROM {_TABLE} WHERE engine = 'listing'"))
    with op.batch_alter_table(_TABLE) as batch_op:
        batch_op.drop_constraint(_CHECK, type_="check")
        batch_op.create_check_constraint(_CHECK, _engines("vllm", "sglang"))
        batch_op.drop_column("max_output_tokens")
