"""A database that stops answering while ``resolve_request_context`` reserves the budget.

The reservation's COMMIT outliving ``db_command_timeout`` raised out of the
route as an unhandled exception, which the ASGI server answered with a bare 500
and a traceback. It is an outage of the gateway's own database, so the caller
gets a retryable 503 in the format it called, and nothing is held for it.
"""

import uuid
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Request, Response
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

import gateway.api.routes._pipeline as pipeline
from gateway.api.routes import chat, messages
from gateway.container import build_container
from gateway.core.config import API_ROOT, GatewayConfig
from gateway.ports.code_execution_policy_port import CodeExecutionPolicyPort
from gateway.ports.model_provider_port import ModelProviderPort
from gateway.repositories.budgets import HeldAmounts
from gateway.services import pricing_service
from gateway.services.budgets import _reservations


def _stub_preamble(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_verify(*args: Any, **kwargs: Any) -> tuple[Any, bool]:
        return SimpleNamespace(
            id="key-1",
            user_id="user-1",
            allowed_models=None,
            exclude_from_budget=False,
            reject_user_mismatch=None,
            is_service_key=False,
            workspace_id=uuid.uuid4(),
        ), False

    async def none(*args: Any, **kwargs: Any) -> None:
        return None

    monkeypatch.setattr(pipeline, "verify_api_key_or_master_key", fake_verify)
    monkeypatch.setattr(pipeline, "check_rate_limit", none)
    monkeypatch.setattr(pricing_service, "resolve_model_pricing", none)
    monkeypatch.setattr(pipeline, "resolve_request_allowlist", none)
    monkeypatch.setattr(pipeline, "organization_for_workspace_id", none)
    monkeypatch.setattr(pipeline, "_budget_minute_limits", none)


async def _resolve(adapter: Any, db: AsyncMock) -> pipeline.RequestContext:
    app = SimpleNamespace(
        state=SimpleNamespace(container=build_container(config=GatewayConfig(), workspace_listener=None))
    )
    request = Request({"type": "http", "method": "POST", "path": f"{API_ROOT}/messages", "headers": [], "app": app})
    return await pipeline.resolve_request_context(
        adapter=adapter,
        raw_request=request,
        response=Response(),
        db=cast(AsyncSession, db),
        uow=None,
        config=GatewayConfig(require_pricing=False),
        log_writer=cast(Any, object()),
        model="openai:gpt-4",
        user_id_from_request=None,
        estimate_prompt_chars=100,
        estimate_max_output_tokens=None,
        master_key_user_required_detail="user required",
        user_forbidden_detail="forbidden",
        code_execution_policies=cast(CodeExecutionPolicyPort, object()),
        model_provider=cast(ModelProviderPort, object()),
    )


@pytest.mark.parametrize("adapter", [chat._ADAPTER, messages._ADAPTER], ids=["chat", "messages"])
@pytest.mark.asyncio
async def test_a_reservation_commit_that_times_out_is_a_retryable_503(
    monkeypatch: pytest.MonkeyPatch, adapter: Any
) -> None:
    _stub_preamble(monkeypatch)
    timeout = OperationalError("database statement timed out (db_command_timeout)", None, TimeoutError())

    async def timing_out(*args: Any, **kwargs: Any) -> None:
        raise timeout

    monkeypatch.setattr(pipeline, "reserve_budget", timing_out)
    db = AsyncMock()

    with pytest.raises(HTTPException) as exc_info:
        await _resolve(adapter, db)

    assert exc_info.value.status_code == 503
    assert exc_info.value.headers == {"Retry-After": pipeline.DATABASE_RETRY_AFTER_SECONDS}
    assert exc_info.value.__cause__ is timeout
    assert "statement" not in str(exc_info.value.detail), "the database's own words stay in the log"
    db.rollback.assert_awaited_once()


@pytest.mark.asyncio
async def test_a_connect_timeout_during_the_reservation_is_a_503_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opening a connection is the one database timeout SQLAlchemy does not translate."""
    _stub_preamble(monkeypatch)

    async def timing_out(*args: Any, **kwargs: Any) -> None:
        raise TimeoutError

    monkeypatch.setattr(pipeline, "reserve_budget", timing_out)

    with pytest.raises(HTTPException) as exc_info:
        await _resolve(chat._ADAPTER, AsyncMock())

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_a_row_the_database_refuses_is_not_answered_as_an_outage(monkeypatch: pytest.MonkeyPatch) -> None:
    """Retrying changes nothing for a data error, so it is not told to retry."""
    _stub_preamble(monkeypatch)

    async def refusing(*args: Any, **kwargs: Any) -> None:
        raise IntegrityError("INSERT", None, Exception("duplicate"))

    monkeypatch.setattr(pipeline, "reserve_budget", refusing)

    with pytest.raises(IntegrityError):
        await _resolve(chat._ADAPTER, AsyncMock())


@pytest.mark.asyncio
async def test_a_failed_user_hold_gives_the_ceilings_holds_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ceilings committed before the per-user hold, so its failure must not strand them."""
    released: list[tuple[list[str], Any]] = []

    async def fake_release(db: Any, ids: list[str], amount: Any, **kwargs: Any) -> None:
        released.append((ids, amount))

    monkeypatch.setattr(_reservations, "release_scoped", fake_release)
    db = AsyncMock()
    db.execute.side_effect = OperationalError("UPDATE users", None, TimeoutError())
    scoped = [cast(Any, SimpleNamespace(budget_id="ceiling-1")), cast(Any, SimpleNamespace(budget_id="ceiling-2"))]

    with pytest.raises(OperationalError):
        await _reservations._hold_on_user(
            db,
            object(),
            scoped=scoped,
            held=HeldAmounts(amount=Decimal(3), tokens=10, requests=1),
        )

    db.rollback.assert_awaited_once()
    assert released == [(["ceiling-1", "ceiling-2"], Decimal(3))]
