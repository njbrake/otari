"""Budget holds commit without waiting for the WAL flush.

Every request of a user writes its ``users`` row, and every request of a key
writes its ceiling's row, and a row lock lasts until the commit returns. A
synchronous commit waits for the flush, so a storage stall that slowed one flush
held the row for its whole length, and every concurrent request on the row gave
up at ``lock_timeout`` (a 97.9 s checkpoint failed twelve requests this way).
"""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
import pytest_asyncio
from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession

from gateway.core.sql import defer_commit_flush
from gateway.models.budgets import BudgetReservation
from gateway.services.budgets import _ledger as ledger
from gateway.services.budgets import increase_reservation, reconcile_reservation, refund_reservation, reserve_budget

from .test_budget_reservation_ledger import _with_budget
from .test_scoped_budgets import Fixture, _build_tenancy, _caps_for_two_providers, _scoped, move

_DEFER = "SET LOCAL synchronous_commit = off"


@pytest_asyncio.fixture
async def tenancy(async_db: AsyncSession) -> Fixture:
    return await _build_tenancy(async_db, "durability")


class _Transactions:
    """The statements of each transaction the engine committed, in order."""

    def __init__(self) -> None:
        self.committed: list[list[str]] = []
        self._open: list[str] = []

    def statement(self, _conn: Any, _cursor: Any, statement: str, *_: Any) -> None:
        self._open.append(" ".join(statement.split()))

    def commit(self, _conn: Any) -> None:
        self.committed.append(self._open)
        self._open = []

    def rollback(self, _conn: Any) -> None:
        self._open = []


@pytest.fixture
def transactions(async_db: AsyncSession) -> Iterator[_Transactions]:
    engine = async_db.get_bind()
    recorded = _Transactions()
    hooks: dict[str, Callable[..., None]] = {
        "before_cursor_execute": recorded.statement,
        "commit": recorded.commit,
        "rollback": recorded.rollback,
    }
    for name, hook in hooks.items():
        event.listen(engine, name, hook)
    yield recorded
    for name, hook in hooks.items():
        event.remove(engine, name, hook)


def _writes_a_hold(statement: str) -> bool:
    return statement.startswith(("UPDATE users ", "UPDATE scoped_budgets ")) and "reserved" in statement


@pytest.mark.asyncio
async def test_every_transaction_that_moves_a_hold_defers_its_flush(
    async_db: AsyncSession, tenancy: Fixture, transactions: _Transactions
) -> None:
    await _with_budget(async_db, tenancy)
    cap = await _scoped(async_db, scope_type="organization", scope_id=str(tenancy.organization_id), max_budget=50.0)
    async_db.add(cap)
    await async_db.commit()

    settled = await reserve_budget(async_db, tenancy.user_id, 2.0, scope=tenancy.scope())
    await increase_reservation(async_db, settled, estimate=3.0)
    await reconcile_reservation(async_db, settled, 1.0)
    refunded = await reserve_budget(async_db, tenancy.user_id, 2.0, scope=tenancy.scope())
    await refund_reservation(async_db, refunded)
    leaked = await reserve_budget(async_db, tenancy.user_id, 2.0, scope=tenancy.scope())
    assert leaked.reservation_id is not None
    row = await async_db.get_one(BudgetReservation, leaked.reservation_id)
    row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await async_db.commit()
    assert await ledger.reclaim_expired_for_user(async_db, tenancy.user_id) == 1
    # Refused by the ceiling, which gives back nothing it took and commits that.
    with pytest.raises(Exception, match="exceeded|budget"):
        await reserve_budget(async_db, tenancy.user_id, 80.0, scope=tenancy.scope())

    _assert_every_hold_defers(transactions, at_least=8)


@pytest.mark.asyncio
async def test_a_fallbacks_move_defers_its_flush(
    async_db: AsyncSession, tenancy: Fixture, transactions: _Transactions
) -> None:
    await _caps_for_two_providers(async_db, tenancy)
    handle = await reserve_budget(async_db, tenancy.user_id, 3.0, scope=tenancy.scope("openai"))
    transactions.committed.clear()

    await move(async_db, handle, "anthropic", cost=3.0)

    _assert_every_hold_defers(transactions, at_least=1)


def _assert_every_hold_defers(transactions: _Transactions, *, at_least: int) -> None:
    moving = [statements for statements in transactions.committed if any(map(_writes_a_hold, statements))]
    assert len(moving) >= at_least, "every path exercised should have committed a hold or a release"
    for statements in moving:
        first_write = next(index for index, statement in enumerate(statements) if _writes_a_hold(statement))
        assert _DEFER in statements[:first_write], statements


@pytest.mark.asyncio
async def test_the_setting_lasts_for_one_transaction(async_db: AsyncSession) -> None:
    await defer_commit_flush(async_db)
    assert (await async_db.execute(text("SHOW synchronous_commit"))).scalar_one() == "off"
    await async_db.commit()
    assert (await async_db.execute(text("SHOW synchronous_commit"))).scalar_one() == "on"
