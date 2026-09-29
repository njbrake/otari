"""Drop the passkey tables, webauthn_credential and webauthn_challenge.

Passkey sign-in is removed, so nothing reads either table. Registered passkeys
are discarded with them. Every identity that held one registered it from inside
a session opened with another credential (a password, the master key, or OAuth),
and that credential still signs it in.

The downgrade recreates both tables empty, with the schema revision e9b3d7f1a5c2
created; the dropped rows are not restored.

Revision ID: c4e8a2f6d0b3
Revises: 9a2bc62cd6ea
Create Date: 2026-09-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c4e8a2f6d0b3"
down_revision: str | Sequence[str] | None = "9a2bc62cd6ea"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A literal rather than an import: the model constant is gone, and the downgrade
# describes the schema of e9b3d7f1a5c2.
_CREDENTIAL_ID_LENGTH = 1364


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_index(op.f("ix_webauthn_challenge_user_id"), table_name="webauthn_challenge")
    op.drop_index(op.f("ix_webauthn_challenge_expires_at"), table_name="webauthn_challenge")
    op.drop_table("webauthn_challenge")
    op.drop_index(op.f("ix_webauthn_credential_user_id"), table_name="webauthn_credential")
    op.drop_index(op.f("ix_webauthn_credential_rp_id"), table_name="webauthn_credential")
    op.drop_index(op.f("ix_webauthn_credential_credential_id"), table_name="webauthn_credential")
    op.drop_table("webauthn_credential")


def downgrade() -> None:
    """Downgrade schema."""
    op.create_table(
        "webauthn_credential",
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("credential_id", sa.String(length=_CREDENTIAL_ID_LENGTH), nullable=False),
        sa.Column("public_key", sa.String(), nullable=False),
        sa.Column("rp_id", sa.String(length=255), nullable=False),
        sa.Column("sign_count", sa.Integer(), nullable=False),
        sa.Column("transports", sa.JSON(), nullable=False),
        sa.Column("backed_up", sa.Boolean(), nullable=False),
        sa.Column("aaguid", sa.String(length=64), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "name", name="uq_webauthn_credential_user_name"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
    )
    op.create_index(
        op.f("ix_webauthn_credential_credential_id"), "webauthn_credential", ["credential_id"], unique=True
    )
    op.create_index(op.f("ix_webauthn_credential_rp_id"), "webauthn_credential", ["rp_id"], unique=False)
    op.create_index(op.f("ix_webauthn_credential_user_id"), "webauthn_credential", ["user_id"], unique=False)

    op.create_table(
        "webauthn_challenge",
        sa.Column("challenge", sa.String(length=255), nullable=False),
        sa.Column("ceremony", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("challenge"),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
    )
    op.create_index(op.f("ix_webauthn_challenge_expires_at"), "webauthn_challenge", ["expires_at"], unique=False)
    op.create_index(op.f("ix_webauthn_challenge_user_id"), "webauthn_challenge", ["user_id"], unique=False)
