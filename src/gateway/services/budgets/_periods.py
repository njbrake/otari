"""How a budget's reset cadence becomes a window.

Every surface that caps spend derives its window here, so a calendar-aligned budget gets the same window on each.
"""

from datetime import UTC, datetime, timedelta

from gateway.core.sql import utc_bound
from gateway.models.budgets import ALIGN_DAY, ALIGN_MONTH, ALIGN_WEEK

# An upper bound on a period length, in seconds (roughly ten years). Without one,
# ``now + timedelta(seconds=...)`` overflows on an arbitrarily large value:
# ``timedelta`` itself refuses more than ``timedelta.max``, so a request near that
# raises ``OverflowError`` (a 500) instead of the 422 an out-of-range period
# should be.
MAX_BUDGET_DURATION_SEC = 10 * 365 * 24 * 3600


def aligned_window(alignment: str, now: datetime) -> tuple[datetime, datetime]:
    """The UTC calendar window containing ``now``.

    Derived from the boundary rather than from ``now`` itself, which is the point:
    a budget rolled late still lands on the window it belongs to, so when anything
    looked at the row stops leaking into the period it gets.
    """
    day = now.astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    if alignment == ALIGN_DAY:
        return day, day + timedelta(days=1)
    if alignment == ALIGN_WEEK:
        # ISO weeks, so a week runs Monday 00:00 to the next Monday 00:00.
        start = day - timedelta(days=day.weekday())
        return start, start + timedelta(days=7)
    if alignment == ALIGN_MONTH:
        start = day.replace(day=1)
        end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
        return start, end
    raise ValueError(f"Unknown reset alignment: {alignment!r}")


def period_window(
    now: datetime,
    *,
    duration: int | None,
    alignment: str | None,
) -> tuple[datetime, datetime] | None:
    """The window a budget with this cadence occupies at ``now``, or None for one that never resets.

    The single place a period is derived, so a window written at creation, a
    window written when a ceiling is materialized, a window rewritten by a
    retiming, and a window rolled at the gate cannot drift apart. Raises
    ``ValueError`` for an alignment this codebase does not know.
    """
    if alignment is not None:
        return aligned_window(alignment, now)
    if duration:
        return now, now + timedelta(seconds=duration)
    return None


def rolled_window(
    now: datetime,
    *,
    duration: int | None,
    alignment: str | None,
) -> tuple[datetime, datetime | None]:
    """Where the gate moves a ceiling whose period ran out, at ``now``.

    Into its cadence's window, or, for a cadence that no longer resets, a window
    open from ``now``. Raises ``ValueError`` as :func:`period_window` does.
    """
    window = period_window(now, duration=duration, alignment=alignment)
    return window if window is not None else (now, None)


def period_has_ended(period_end: datetime | None, now: datetime) -> bool:
    """Whether a stored period has run out at ``now``. One that never ends never has."""
    ends = utc_bound(period_end)
    return ends is not None and now >= ends


def effective_period(
    period_end: datetime | None,
    now: datetime,
    *,
    duration: int | None,
    alignment: str | None,
) -> tuple[datetime, datetime | None] | None:
    """The window a ceiling whose stored period ends at ``period_end`` has rolled into at ``now``.

    None while the stored period still runs (or never ends): the stored window is
    the one in force. Once it has run out, the gate rolls the ceiling into
    :func:`rolled_window` when a request next reaches it, and a read before then
    must report what that roll will leave. Raises ``ValueError`` as
    :func:`period_window` does.
    """
    if not period_has_ended(period_end, now):
        return None
    return rolled_window(now, duration=duration, alignment=alignment)


def budget_window(now: datetime, budget: object) -> tuple[datetime, datetime] | None:
    """The window a ``Budget`` row occupies at ``now``, or None if it never resets.

    A thin read of :func:`period_window` off the two columns, so a caller holding
    a budget cannot accidentally consult one of them and not the other. That is
    the bug this module exists to stop: reading only ``budget_duration_sec``
    silently ignores a calendar cadence, and the row then never resets at all.
    """
    return period_window(
        now,
        duration=getattr(budget, "budget_duration_sec", None),
        alignment=getattr(budget, "reset_alignment", None),
    )


__all__ = [
    "MAX_BUDGET_DURATION_SEC",
    "aligned_window",
    "budget_window",
    "effective_period",
    "period_has_ended",
    "period_window",
    "rolled_window",
]
