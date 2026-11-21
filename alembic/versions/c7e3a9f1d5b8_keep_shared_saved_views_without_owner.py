"""Keep a shared saved view when the account that saved it is deleted.

``saved_views.user_id`` becomes nullable with SET NULL. Account deletion removes
the account's private views itself, so only a shared view is left without an
owner, and the workspace's managers keep it from then on.

Revision ID: c7e3a9f1d5b8
Revises: 496bdc06a5f1
Create Date: 2026-11-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c7e3a9f1d5b8"
down_revision: str | Sequence[str] | None = "496bdc06a5f1"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "saved_views"
_COLUMN = "user_id"
_FK = "fk_saved_views_user"
_CHECK = "ck_saved_views_owned_or_shared"


def _named(fallback: str) -> str:
    """The name the live schema gives the foreign key on ``_COLUMN``, or ``fallback``.

    The constraint this replaces was created without a name, so reflection says
    what the engine called it.
    """
    for key in sa.inspect(op.get_bind()).get_foreign_keys(_TABLE):
        if key["constrained_columns"] == [_COLUMN] and key.get("name"):
            return str(key["name"])
    return fallback


def _views(*, nullable: bool) -> sa.Table:
    """The table as it stands, minus the constraint being replaced, for SQLite's rebuild."""
    return sa.Table(
        _TABLE,
        sa.MetaData(),
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column(_COLUMN, sa.Uuid(), nullable=nullable),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspace.id", ondelete="CASCADE"), nullable=False),
        sa.Column("page", sa.String(16), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("query", sa.String(2000), nullable=False),
        sa.Column("shared", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Index("uq_saved_views_owner_name", "workspace_id", "page", _COLUMN, sa.text("lower(name)"), unique=True),
        sa.Index("ix_saved_views_user_id", _COLUMN),
    )


def _repoint(*, nullable: bool, ondelete: str) -> None:
    # Read before the block opens: inside it the table may already be a copy.
    drop = _named(_FK)
    with op.batch_alter_table(_TABLE, copy_from=_views(nullable=not nullable)) as batch:
        batch.alter_column(_COLUMN, existing_type=sa.Uuid(), nullable=nullable)
        if op.get_bind().dialect.name != "sqlite":
            # SQLite's rebuild leaves the old constraint behind with the table; every
            # other engine alters in place and has to be told to drop it.
            batch.drop_constraint(drop, type_="foreignkey")
        batch.create_foreign_key(_FK, "user", [_COLUMN], ["id"], ondelete=ondelete)


def upgrade() -> None:
    _repoint(nullable=True, ondelete="SET NULL")
    # Only a shared view may outlive its owner: an ownerless private view is one
    # nobody can see or delete.
    with op.batch_alter_table(_TABLE) as batch:
        batch.create_check_constraint(_CHECK, sa.text(f"{_COLUMN} IS NOT NULL OR shared"))


def downgrade() -> None:
    # A view whose owner is gone has nobody to point at, so it goes.
    op.execute(sa.text(f"DELETE FROM {_TABLE} WHERE {_COLUMN} IS NULL"))
    if op.get_bind().dialect.name != "sqlite":
        # SQLite's rebuild below copies the table without it.
        op.drop_constraint(_CHECK, _TABLE, type_="check")
    _repoint(nullable=False, ondelete="CASCADE")
