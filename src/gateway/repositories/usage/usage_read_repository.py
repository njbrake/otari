"""Queries behind the usage log's reads: a page of rows, the attempts folded into them, and latency.

Each takes the conditions the caller already built from the request's filters
(``_usage_filters`` and its scope), so the filters are read one way however the
rows are asked for.
"""

from collections.abc import Collection

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from gateway.core.sql import dialect_name
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User


async def usage_rows(
    db: AsyncSession,
    conditions: list[ColumnElement[bool]],
    *,
    skip: int,
    limit: int,
) -> list[tuple[UsageLog, str | None, str | None]]:
    """A page of usage rows, newest first, each with its billed user's alias and its API key's name.

    Outer-joined rather than looked up per row, and rather than left to the
    client: naming a page of rows must not cost a round trip each, nor oblige a
    dashboard to hold every user and every key in memory to label 100 rows.
    Outer so a row whose owner was deleted still comes back, with a null label.
    """
    stmt = (
        select(UsageLog, User.alias, APIKey.key_name)
        .outerjoin(User, User.user_id == UsageLog.user_id)
        .outerjoin(APIKey, APIKey.id == UsageLog.api_key_id)
        .where(*conditions)
        .order_by(UsageLog.timestamp.desc())
        .offset(skip)
        .limit(limit)
    )
    return [(log, alias, key_name) for log, alias, key_name in (await db.execute(stmt)).all()]


async def absorbed_attempts(
    db: AsyncSession,
    request_groups: Collection[str],
    scope: ColumnElement[bool] | None,
) -> dict[str, int]:
    """How many earlier failed attempts each of these routed requests had, by request group.

    One grouped query over the groups rather than a subquery per row. Absorbed
    rows share their request's user and workspace, so they are already in scope;
    the scope is applied anyway so this can never count a row the caller could not
    list.
    """
    if not request_groups:
        return {}
    conditions: list[ColumnElement[bool]] = [
        UsageLog.request_group_id.in_(request_groups),
        UsageLog.status == "absorbed",
    ]
    if scope is not None:
        conditions.append(scope)
    rows = (
        await db.execute(
            select(UsageLog.request_group_id, func.count()).where(*conditions).group_by(UsageLog.request_group_id)
        )
    ).all()
    return {group: count for group, count in rows}


async def p95_latency_ms(db: AsyncSession, conditions: list[ColumnElement[bool]]) -> int | None:
    """Nearest-rank 95th-percentile latency over the requests in ``conditions``.

    PostgreSQL computes it in one pass with ``percentile_disc``. SQLite has no
    ordered-set aggregate, so there it is the row at rank ``ceil(0.95 * n)`` of the
    latencies in ascending order, which is the value ``percentile_disc`` returns,
    so both engines answer the same number for the same rows. Either way it sorts
    the window's latencies once, which the timestamp bound keeps finite.
    """
    measured = [*conditions, UsageLog.status != "absorbed", UsageLog.latency_ms.is_not(None)]
    if dialect_name(db) != "sqlite":
        value = (
            await db.execute(
                select(func.percentile_disc(0.95).within_group(UsageLog.latency_ms.asc())).where(*measured)
            )
        ).scalar_one_or_none()
        return int(value) if value is not None else None
    count = (await db.execute(select(func.count()).select_from(UsageLog).where(*measured))).scalar_one()
    if not count:
        return None
    rank = (count * 95 + 99) // 100
    value = (
        await db.execute(
            select(UsageLog.latency_ms).where(*measured).order_by(UsageLog.latency_ms.asc()).offset(rank - 1).limit(1)
        )
    ).scalar_one_or_none()
    return int(value) if value is not None else None
