"""The telemetry retention sweep deletes old imported rows and never served usage."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from gateway.adapters.telemetry_storage_adapter import DatabaseTelemetryStorageAdapter
from gateway.api.deps import build_telemetry_retention_service
from gateway.core.unit_of_work import UnitOfWork
from gateway.models.tenancy import Workspace
from gateway.models.usage import AgentTelemetry, UsageLog

_NOW = datetime(2026, 9, 29, 12, 0, tzinfo=UTC)
_OLD = _NOW - timedelta(days=91)
_RECENT = _NOW - timedelta(days=89)


def _usage(workspace_id: object, row_id: str, *, source: str, timestamp: datetime, counts: bool) -> UsageLog:
    return UsageLog(
        id=row_id,
        workspace_id=workspace_id,
        timestamp=timestamp,
        model="claude-sonnet-5-5",
        endpoint="/v1/messages" if source == "gateway" else "external",
        source=source,
        counts_toward_budget=counts,
        status="success",
    )


def _event(row_id: str, timestamp: datetime) -> AgentTelemetry:
    return AgentTelemetry(id=row_id, timestamp=timestamp, name="tool_result", source="claude_code", dedup_key=row_id)


@pytest.mark.asyncio
async def test_only_expired_imported_rows_are_deleted(async_db: AsyncSession) -> None:
    workspace_id = (await async_db.execute(select(col(Workspace.id)).limit(1))).scalar_one()
    async_db.add_all(
        [
            _usage(workspace_id, "old-import-1", source="claude_code", timestamp=_OLD, counts=False),
            _usage(workspace_id, "old-import-2", source="codex", timestamp=_OLD, counts=False),
            _usage(workspace_id, "old-import-3", source="claude_code", timestamp=_OLD, counts=False),
            _usage(workspace_id, "recent-import", source="claude_code", timestamp=_RECENT, counts=False),
            _usage(workspace_id, "old-served", source="gateway", timestamp=_OLD, counts=True),
            # Budget-exempt gateway traffic is still this deployment's billing record.
            _usage(workspace_id, "old-served-exempt", source="gateway", timestamp=_OLD, counts=False),
            _event("old-event", _OLD),
            _event("recent-event", _RECENT),
        ]
    )
    await async_db.commit()

    retention = build_telemetry_retention_service(UnitOfWork(async_db), DatabaseTelemetryStorageAdapter(async_db))
    removed = await retention.sweep(90, now=_NOW, batch_size=2)

    assert (removed.usage, removed.agent_telemetry) == (3, 1)
    usage_left = set((await async_db.execute(select(UsageLog.id))).scalars())
    assert usage_left == {"recent-import", "old-served", "old-served-exempt"}
    events_left = set((await async_db.execute(select(AgentTelemetry.id))).scalars())
    assert events_left == {"recent-event"}
