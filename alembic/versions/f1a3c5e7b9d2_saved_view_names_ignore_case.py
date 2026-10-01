"""Make a person's saved view names unique ignoring case.

The menu sorts views by ``lower(name)``, so "Slow calls" and "slow calls" read
as one entry twice. The unique constraint on ``(workspace_id, page, user_id,
name)`` becomes a unique index on ``(workspace_id, page, user_id, lower(name))``.

A name that already collides with another of its owner's, ignoring case, is
renamed with a numeric suffix first, so the index can build. The constraint is
dropped through ``batch_alter_table`` because SQLite has no ``ALTER TABLE ...
DROP CONSTRAINT``, and ``copy_from`` carries the foreign keys and the owner index
through SQLite's rebuild.

Revision ID: f1a3c5e7b9d2
Revises: e4b8d2f6a1c3
Create Date: 2026-10-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f1a3c5e7b9d2"
down_revision: str | Sequence[str] | None = "e4b8d2f6a1c3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "saved_view"
_CONSTRAINT = "uq_saved_view_owner_name"
_INDEX = "uq_saved_view_owner_lower_name"
_OWNER_COLUMNS = ["workspace_id", "page", "user_id"]
_MAX_NAME_LENGTH = 80


def _saved_view(*, unique_name: bool) -> sa.Table:
    """The table on either side of this revision, for ``copy_from``."""
    table = sa.Table(
        _TABLE,
        sa.MetaData(),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("page", sa.String(length=40), nullable=False),
        sa.Column("name", sa.String(length=_MAX_NAME_LENGTH), nullable=False),
        sa.Column("query", sa.String(length=2000), nullable=False),
        sa.Column("shared", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        *([sa.UniqueConstraint(*_OWNER_COLUMNS, "name", name=_CONSTRAINT)] if unique_name else []),
    )
    sa.Index("ix_saved_view_user_id", table.c.user_id)
    return table


def _rename_case_collisions() -> None:
    """Suffix every name that repeats another of its owner's on a page, ignoring case, oldest kept."""
    table = _saved_view(unique_name=True)
    bind = op.get_bind()
    rows = bind.execute(
        sa.select(table.c.id, table.c.workspace_id, table.c.page, table.c.user_id, table.c.name).order_by(
            table.c.created_at, table.c.id
        )
    ).all()
    taken: set[tuple[object, object, object, str]] = set()
    for row in rows:
        owner = (row.workspace_id, row.page, row.user_id)
        name = row.name
        suffix = 1
        while (*owner, name.lower()) in taken:
            suffix += 1
            tail = f" ({suffix})"
            name = row.name[: _MAX_NAME_LENGTH - len(tail)] + tail
        taken.add((*owner, name.lower()))
        if name != row.name:
            bind.execute(sa.update(table).where(table.c.id == row.id).values(name=name))


def upgrade() -> None:
    _rename_case_collisions()
    with op.batch_alter_table(_TABLE, copy_from=_saved_view(unique_name=True)) as batch_op:
        batch_op.drop_constraint(_CONSTRAINT, type_="unique")
    op.create_index(_INDEX, _TABLE, [*_OWNER_COLUMNS, sa.text("lower(name)")], unique=True)


def downgrade() -> None:
    op.drop_index(_INDEX, table_name=_TABLE)
    with op.batch_alter_table(_TABLE, copy_from=_saved_view(unique_name=False)) as batch_op:
        batch_op.create_unique_constraint(_CONSTRAINT, [*_OWNER_COLUMNS, "name"])
