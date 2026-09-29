"""Drop the guardrails feature's storage.

Removes ``organization_guardrails`` and ``organization_guardrail_workspaces``,
the deployment-wide ``guardrails_url`` override in ``runtime_settings``, and the
``guardrails`` key from every stored ``routing_policies.spec`` (every alias
migrated into a policy by ``b5d7f9a1c3e6`` carries ``guardrails: []``).
``PolicySpec`` also discards that key on load, so a row this migration has not
seen, such as one written by an older replica during a rolling deploy, still
loads.

The downgrade recreates both tables empty. The rows they held, the
``guardrails_url`` override and any policy's guardrail list are not restored.

Revision ID: ff79906d013d
Revises: 9a2bc62cd6ea
Create Date: 2026-09-29
"""

import json
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ff79906d013d"
down_revision: str | Sequence[str] | None = "9a2bc62cd6ea"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_UNIQUE_NAME = "uq_organization_guardrails_org_profile"

_routing_policies = sa.table("routing_policies", sa.column("id", sa.String()), sa.column("spec", sa.JSON()))


def _strip_policy_guardrails() -> None:
    conn = op.get_bind()
    rows = conn.execute(sa.select(_routing_policies.c.id, _routing_policies.c.spec)).all()
    for row_id, spec in rows:
        if isinstance(spec, str):
            spec = json.loads(spec)
        if not isinstance(spec, dict) or "guardrails" not in spec:
            continue
        spec = {key: value for key, value in spec.items() if key != "guardrails"}
        conn.execute(sa.update(_routing_policies).where(_routing_policies.c.id == row_id).values(spec=spec))


def upgrade() -> None:
    """Upgrade schema."""
    op.drop_index(
        op.f("ix_organization_guardrail_workspaces_workspace_id"),
        table_name="organization_guardrail_workspaces",
    )
    op.drop_table("organization_guardrail_workspaces")
    op.drop_index(
        op.f("ix_organization_guardrails_organization_id"),
        table_name="organization_guardrails",
    )
    op.drop_table("organization_guardrails")
    op.execute(sa.text("DELETE FROM runtime_settings WHERE key = 'guardrails_url'"))
    _strip_policy_guardrails()


def downgrade() -> None:
    """Downgrade schema."""
    op.create_table(
        "organization_guardrails",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("organization_id", sa.Uuid(), nullable=False),
        sa.Column("profile", sa.String(), nullable=False),
        sa.Column("url", sa.String(), nullable=True),
        sa.Column("encrypted_credential", sa.Text(), nullable=True),
        sa.Column("mode", sa.String(), nullable=False),
        sa.Column("on_unavailable", sa.String(), nullable=False),
        sa.Column("validate_kwargs", sa.JSON(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("applies_to_all_workspaces", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["organization_id"], ["organization.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("organization_id", "profile", name=_UNIQUE_NAME),
    )
    op.create_index(
        op.f("ix_organization_guardrails_organization_id"),
        "organization_guardrails",
        ["organization_id"],
    )
    op.create_table(
        "organization_guardrail_workspaces",
        sa.Column("organization_guardrail_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("organization_guardrail_id", "workspace_id"),
        sa.ForeignKeyConstraint(["organization_guardrail_id"], ["organization_guardrails.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"], ondelete="CASCADE"),
    )
    op.create_index(
        op.f("ix_organization_guardrail_workspaces_workspace_id"),
        "organization_guardrail_workspaces",
        ["workspace_id"],
    )
