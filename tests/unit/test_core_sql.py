"""Unit tests for the cross-layer SQL helpers in `gateway.core.sql`."""

import sqlite3
import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest
from sqlalchemy import Column, MetaData, Table, Uuid, create_engine, insert, select

from gateway.core.sql import LIKE_ESCAPE, contains_pattern, utc_bound, uuid_text


def _like(text: str, term: str) -> bool:
    """Evaluate ``lower(text) LIKE contains_pattern(term)`` the way the repositories do."""
    with sqlite3.connect(":memory:") as connection:
        row = connection.execute(
            "SELECT lower(?) LIKE ? ESCAPE ?", (text, contains_pattern(term), LIKE_ESCAPE)
        ).fetchone()
    return bool(row[0])


def test_contains_pattern_escapes_the_escape_character_before_the_wildcards() -> None:
    """Escaping ``%`` first and the backslash second would double the backslash the
    wildcard's escape just added, turning ``\\%`` back into a live wildcard."""
    assert contains_pattern("a\\b") == "%a\\\\b%"
    assert contains_pattern("100%") == "%100\\%%"
    assert contains_pattern("a_b") == "%a\\_b%"


def test_contains_pattern_folds_case() -> None:
    assert contains_pattern("Ada") == "%ada%"


@pytest.mark.parametrize(
    ("text", "term", "matches"),
    [
        ("100% Cotton", "100%", True),
        ("1000 Cotton", "100%", False),
        ("ada_l@example.com", "a_l", True),
        ("adaxl@example.com", "a_l", False),
        ("C:\\Users\\ada", "\\users", True),
        ("C:/Users/ada", "\\users", False),
        ("Ada Lovelace", "LOVELACE", True),
    ],
)
def test_contains_pattern_matches_its_term_literally(text: str, term: str, *, matches: bool) -> None:
    """A search box takes whatever is typed, so ``%``, ``_`` and ``\\`` are text, not syntax."""
    assert _like(text, term) is matches


def test_naive_bound_is_pinned_to_utc() -> None:
    """An offset-less ISO bound would otherwise resolve against the process's local
    timezone, so the same query would select different rows per deployment."""
    assert utc_bound(datetime(2026, 8, 12, 8, 0)) == datetime(2026, 8, 12, 8, 0, tzinfo=UTC)


def test_aware_bound_is_left_alone() -> None:
    offset = timezone(timedelta(hours=-4))
    aware = datetime(2026, 8, 12, 8, 0, tzinfo=offset)
    assert utc_bound(aware) is aware


def test_missing_bound_stays_missing() -> None:
    assert utc_bound(None) is None


def test_a_naive_stored_timestamp_subtracts_from_an_aware_now() -> None:
    """SQLite hands a timezone-aware column back naive; read through this, it compares with ``now(UTC)``."""
    assert (datetime.now(UTC) - utc_bound(datetime(2026, 5, 19, 12, 0))).total_seconds() >= 0


def test_uuid_text_renders_what_str_uuid_gives_on_sqlite_and_postgresql() -> None:
    """SQLite stores a ``Uuid`` as bare hex, so a plain cast there matches no ``str(uuid)`` id."""
    identity = uuid.uuid4()
    table = Table("t", MetaData(), Column("u", Uuid))
    engine = create_engine("sqlite://")
    table.metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(insert(table).values(u=identity))
        assert connection.execute(select(uuid_text(table.c.u))).scalar_one() == str(identity)
    assert str(
        select(uuid_text(table.c.u)).compile(dialect=create_engine("postgresql+psycopg2://").dialect)
    ).startswith("SELECT CAST(t.u AS VARCHAR)")
