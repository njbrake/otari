"""A failed stored-provider write logs its cause without the row's secrets."""

import logging
from collections.abc import Iterator
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError, InvalidRequestError, OperationalError

from gateway.api.routes.providers import _commit, _db_error_summary

SECRET = "aws-secret-that-must-not-be-logged"


class LockNotAvailableError(Exception):
    """Stands in for asyncpg's exception, whose ``str`` appends the server's DETAIL."""

    sqlstate = "55P03"

    def __str__(self) -> str:
        return f"canceling statement due to lock timeout\nDETAIL:  Failing row contains ({SECRET})"


def _asyncpg_error(driver: Exception, sqlstate: str) -> OperationalError:
    """Build the error SQLAlchemy raises: an adapted DBAPI error caused by asyncpg's."""
    adapted = Exception(f"{type(driver)}: {driver}")
    adapted.sqlstate = sqlstate  # type: ignore[attr-defined]
    adapted.__cause__ = driver
    return OperationalError("INSERT INTO provider_credentials ...", {"client_args": SECRET}, adapted)


@pytest.fixture
def gateway_log(caplog: pytest.LogCaptureFixture) -> Iterator[pytest.LogCaptureFixture]:
    gateway_logger = logging.getLogger("gateway")
    gateway_logger.addHandler(caplog.handler)
    caplog.set_level(logging.ERROR, logger="gateway")
    try:
        yield caplog
    finally:
        gateway_logger.removeHandler(caplog.handler)


def _session(error: BaseException) -> AsyncMock:
    db = AsyncMock()
    db.commit.side_effect = error
    return db


@pytest.mark.asyncio
async def test_lock_timeout_is_logged_by_class_and_sqlstate(gateway_log: pytest.LogCaptureFixture) -> None:
    error = _asyncpg_error(LockNotAvailableError(), "55P03")
    assert SECRET in str(error)  # what a plain logger.exception would have written

    db = _session(error)
    with pytest.raises(HTTPException) as raised:
        await _commit(db, "otari-ai")

    assert raised.value.status_code == 500
    db.rollback.assert_awaited_once()
    assert "Failed to write stored provider 'otari-ai': LockNotAvailableError (SQLSTATE 55P03)" in gateway_log.text
    assert SECRET not in gateway_log.text


@pytest.mark.asyncio
async def test_integrity_error_without_conflict_detail_is_logged(gateway_log: pytest.LogCaptureFixture) -> None:
    driver = Exception("duplicate key")
    adapted = Exception(str(driver))
    adapted.sqlstate = "23505"  # type: ignore[attr-defined]
    error = IntegrityError("INSERT ...", {"client_args": SECRET}, adapted)

    with pytest.raises(HTTPException) as raised:
        await _commit(_session(error), "otari-ai")

    assert raised.value.status_code == 500
    assert "(SQLSTATE 23505)" in gateway_log.text
    assert SECRET not in gateway_log.text


@pytest.mark.asyncio
async def test_conflict_is_a_409_and_not_logged(gateway_log: pytest.LogCaptureFixture) -> None:
    error = IntegrityError("INSERT ...", {}, Exception("duplicate key"))

    with pytest.raises(HTTPException) as raised:
        await _commit(_session(error), "otari-ai", conflict_detail="already exists")

    assert raised.value.status_code == 409
    assert gateway_log.text == ""


@pytest.mark.asyncio
async def test_bare_timeout_is_caught_and_logged(gateway_log: pytest.LogCaptureFixture) -> None:
    # A connect timeout is not translated into a SQLAlchemyError (see core/database.DATABASE_ERRORS).
    with pytest.raises(HTTPException) as raised:
        await _commit(_session(TimeoutError()), "otari-ai")

    assert raised.value.status_code == 500
    assert "Failed to write stored provider 'otari-ai': TimeoutError" in gateway_log.text


@pytest.mark.asyncio
async def test_cause_is_logged_even_when_the_rollback_fails(gateway_log: pytest.LogCaptureFixture) -> None:
    db = _session(TimeoutError())
    db.rollback.side_effect = TimeoutError()

    with pytest.raises(TimeoutError):
        await _commit(db, "otari-ai")

    assert "Failed to write stored provider 'otari-ai': TimeoutError" in gateway_log.text


def test_summary_without_a_driver_error_names_the_class() -> None:
    assert _db_error_summary(InvalidRequestError("state")) == "InvalidRequestError"


def test_client_side_command_timeout_has_no_sqlstate() -> None:
    error = OperationalError("COMMIT", {}, TimeoutError())
    assert _db_error_summary(error) == "TimeoutError"
