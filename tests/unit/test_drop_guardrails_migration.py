"""The revision that removes guardrails' storage, exercised on SQLite.

Stored data is the part worth pinning: every alias migrated into a policy was
written with ``guardrails: []``, so the upgrade has to strip that key from real
rows without touching the rest of the spec, and a policy that never had it must
come through unchanged. The downgrade recreates the two tables it dropped.
"""

import json
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, create_engine, inspect, text

_ALEMBIC_DIR = Path(__file__).resolve().parents[2] / "alembic"
_REVISION = "ff79906d013d"
_BEFORE = "9a2bc62cd6ea"
_TABLES = ("organization_guardrails", "organization_guardrail_workspaces")


def _alembic_config(database_url: str) -> Config:
    config = Config()
    config.set_main_option("script_location", str(_ALEMBIC_DIR))
    config.set_main_option("sqlalchemy.url", database_url)
    config.attributes["configure_logger"] = False
    return config


@pytest.fixture
def before_drop(tmp_path: Path) -> Iterator[tuple[Config, Engine]]:
    database_url = f"sqlite:///{tmp_path / 'drop-guardrails.db'}"
    config = _alembic_config(database_url)
    command.upgrade(config, _BEFORE)
    engine = create_engine(database_url)
    try:
        yield config, engine
    finally:
        engine.dispose()


def _insert_policy(engine: Engine, policy_id: str, name: str, spec: dict[str, object]) -> None:
    with engine.begin() as conn:
        # The migration chain seeds the deployment's default workspace.
        workspace_id = conn.execute(text("SELECT id FROM workspace LIMIT 1")).scalar_one()
        conn.execute(
            text(
                "INSERT INTO routing_policies (id, name, spec, workspace_id, created_at, updated_at) "
                "VALUES (:id, :name, :spec, :workspace_id, '2026-09-01 00:00:00', '2026-09-01 00:00:00')"
            ),
            {"id": policy_id, "name": name, "spec": json.dumps(spec), "workspace_id": workspace_id},
        )


def _spec(engine: Engine, policy_id: str) -> dict[str, object]:
    with engine.connect() as conn:
        raw = conn.execute(text("SELECT spec FROM routing_policies WHERE id = :id"), {"id": policy_id}).scalar_one()
    spec: dict[str, object] = json.loads(raw)
    return spec


def test_upgrade_strips_stored_guardrails_and_drops_the_tables(before_drop: tuple[Config, Engine]) -> None:
    config, engine = before_drop
    migrated = {"spec_version": 1, "select": [{"default": "openai:gpt-5"}], "on_failure": [], "guardrails": []}
    mandated = {
        "spec_version": 1,
        "select": [{"default": "openai:gpt-5"}],
        "on_failure": ["anthropic:claude-haiku-4-5"],
        "guardrails": [{"profile": "prompt-injection", "mode": "block", "on_unavailable": "block"}],
    }
    plain = {"spec_version": 1, "select": [{"default": "openai:gpt-5-mini"}]}
    _insert_policy(engine, "p-migrated", "migrated", migrated)
    _insert_policy(engine, "p-mandated", "mandated", mandated)
    _insert_policy(engine, "p-plain", "plain", plain)
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO runtime_settings (key, value, updated_at) "
                "VALUES ('guardrails_url', 'http://guardrails:8000', '2026-09-01 00:00:00')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO organization_guardrails (id, organization_id, profile, mode, on_unavailable, enabled, "
                "applies_to_all_workspaces, created_at, updated_at) VALUES (:id, :org, 'prompt-injection', 'block', "
                "'block', 1, 1, '2026-09-01 00:00:00', '2026-09-01 00:00:00')"
            ),
            {"id": uuid.uuid4().hex, "org": uuid.uuid4().hex},
        )

    command.upgrade(config, _REVISION)

    assert _spec(engine, "p-migrated") == {"spec_version": 1, "select": [{"default": "openai:gpt-5"}], "on_failure": []}
    assert _spec(engine, "p-mandated") == {
        "spec_version": 1,
        "select": [{"default": "openai:gpt-5"}],
        "on_failure": ["anthropic:claude-haiku-4-5"],
    }
    assert _spec(engine, "p-plain") == plain
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM runtime_settings WHERE key = 'guardrails_url'")).scalar() == 0
    tables = set(inspect(engine).get_table_names())
    assert tables.isdisjoint(_TABLES)


def test_downgrade_recreates_the_tables(before_drop: tuple[Config, Engine]) -> None:
    config, engine = before_drop
    command.upgrade(config, _REVISION)

    command.downgrade(config, _BEFORE)

    inspector = inspect(engine)
    assert set(_TABLES) <= set(inspector.get_table_names())
    assert {index["name"] for index in inspector.get_indexes("organization_guardrails")} == {
        "ix_organization_guardrails_organization_id"
    }
    command.upgrade(config, "head")
    assert set(inspect(engine).get_table_names()).isdisjoint(_TABLES)
