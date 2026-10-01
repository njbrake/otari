"""Queries behind the usage log's reads: a page of rows, the attempts folded into them, latency, and groups.

Each takes the conditions the caller already built from the request's filters
(``_usage_filters`` and its scope), so the filters are read one way however the
rows are asked for.
"""

from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Never

from sqlalchemy import ColumnElement, case, func, null, or_, select

from gateway.core.sql import dialect_name
from gateway.core.unit_of_work import UnitOfWork
from gateway.core.usage_filters import (
    API_KEY_LABEL,
    USER_LABEL,
    LabelJoin,
    SortOrder,
    UsageSort,
    billed_input_sum,
    billed_meter,
    billed_output_sum,
    billed_tokens,
    request_count,
)
from gateway.core.usage_source import not_served_here
from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User
from gateway.repositories.base_repository import BaseRepository
from gateway.schemas.usage import ActivityGroupBy, ActivityGroupOrder

# What a page is ordered by for each key but time, which ``_ordering`` handles
# itself. Text keys ignore case.
_SORT_KEYS: dict[str, Any] = {
    "tokens": billed_tokens(),
    "cost": UsageLog.cost,
    "latency": UsageLog.latency_ms,
    "model": func.lower(UsageLog.model),
    "source": func.lower(func.coalesce(APIKey.key_name, UsageLog.source)),
    "member": func.lower(func.coalesce(User.alias, UsageLog.user_id)),
    "policy": func.lower(UsageLog.policy_name),
    # A request served on a later attempt had an earlier one fail, so it ranks with
    # the absorbed attempts, between the failures and the clean successes.
    "status": case(
        (UsageLog.status == "error", 2),
        (or_(UsageLog.status == "absorbed", UsageLog.attempt_position > 1), 1),
        else_=0,
    ),
}


def _ordering(sort: UsageSort, order: SortOrder) -> tuple[Any, ...]:
    """ORDER BY for a page: the chosen key with empty values last, then newest first.

    The id closes the ordering so rows tied on every other key keep one order
    across pages; without it, OFFSET paging could repeat or skip a row.
    """
    if sort == "timestamp":
        # Not nulls_last(): the column is never NULL, and DESC NULLS LAST would stop
        # PostgreSQL scanning the timestamp index backwards.
        if order == "asc":
            return UsageLog.timestamp.asc(), UsageLog.id.asc()
        return UsageLog.timestamp.desc(), UsageLog.id.desc()
    key = _SORT_KEYS[sort]
    primary = (key.asc() if order == "asc" else key.desc()).nulls_last()
    return primary, UsageLog.timestamp.desc(), UsageLog.id.desc()


# The column each grouping collapses on, and the join that names its values.
_GROUP_COLUMNS: dict[ActivityGroupBy, tuple[Any, LabelJoin | None]] = {
    "api_key": (UsageLog.api_key_id, API_KEY_LABEL),
    "source_label": (UsageLog.source_label, None),
    "model": (UsageLog.model, None),
    "user": (UsageLog.user_id, USER_LABEL),
    "policy": (UsageLog.policy_name, None),
    "alias": (UsageLog.requested_model, None),
}
# An alias is a requested name that is not the model which served, in any of the
# forms a caller may send it (``provider/model`` is deprecated but still accepted),
# nor the policy that routed it.
_ALIASED = (
    UsageLog.requested_model.is_not(None),
    UsageLog.requested_model != UsageLog.model,
    UsageLog.requested_model.is_distinct_from(UsageLog.provider + ":" + UsageLog.model),
    UsageLog.requested_model.is_distinct_from(UsageLog.provider + "/" + UsageLog.model),
    UsageLog.requested_model.is_distinct_from(UsageLog.policy_name),
)
# How many models a group names; the row shows these and "+N" for the rest.
_GROUP_MODELS_SHOWN = 2


@dataclass(frozen=True)
class ActivityGroupRow:
    """One group's totals, as :meth:`UsageReadRepository.activity_groups` reads them."""

    key: str | None
    label: str | None
    requests: int
    errors: int
    absorbed: int
    cost: float
    imported_cost: float
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    latency_ms: int
    first_at: datetime
    last_at: datetime
    models: list[str]
    model_count: int


class UsageReadRepository(BaseRepository[UsageLog, Never, Never]):
    """Read usage rows in the open block of a Unit of Work."""

    def __init__(self, uow: UnitOfWork) -> None:
        super().__init__(uow, UsageLog)

    async def usage_rows(
        self,
        conditions: list[ColumnElement[bool]],
        *,
        sort: UsageSort,
        order: SortOrder,
        skip: int,
        limit: int,
    ) -> list[tuple[UsageLog, str | None, str | None]]:
        """A page of usage rows in the order asked for, each with its billed user's alias and its API key's name.

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
            .order_by(*_ordering(sort, order))
            .offset(skip)
            .limit(limit)
        )
        return [(log, alias, key_name) for log, alias, key_name in (await self.db.execute(stmt)).all()]

    async def absorbed_attempts(
        self,
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
            await self.db.execute(
                select(UsageLog.request_group_id, func.count()).where(*conditions).group_by(UsageLog.request_group_id)
            )
        ).all()
        return {group: count for group, count in rows}

    async def p95_latency_ms(self, conditions: list[ColumnElement[bool]]) -> int | None:
        """Nearest-rank 95th-percentile latency over the requests in ``conditions``.

        PostgreSQL computes it in one pass with ``percentile_disc``. SQLite has no
        ordered-set aggregate, so there it is the row at rank ``ceil(0.95 * n)`` of the
        latencies in ascending order, which is the value ``percentile_disc`` returns,
        so both engines answer the same number for the same rows. Either way it sorts
        the window's latencies once, which the timestamp bound keeps finite.
        """
        measured = [*conditions, UsageLog.status != "absorbed", UsageLog.latency_ms.is_not(None)]
        if dialect_name(self.db) != "sqlite":
            value = (
                await self.db.execute(
                    select(func.percentile_disc(0.95).within_group(UsageLog.latency_ms.asc())).where(*measured)
                )
            ).scalar_one_or_none()
            return int(value) if value is not None else None
        count = (await self.db.execute(select(func.count()).select_from(UsageLog).where(*measured))).scalar_one()
        if not count:
            return None
        rank = (count * 95 + 99) // 100
        value = (
            await self.db.execute(
                select(UsageLog.latency_ms)
                .where(*measured)
                .order_by(UsageLog.latency_ms.asc())
                .offset(rank - 1)
                .limit(1)
            )
        ).scalar_one_or_none()
        return int(value) if value is not None else None

    async def _group_models(
        self,
        column: Any,
        keys: list[str | None],
        conditions: list[ColumnElement[bool]],
        status: str | None,
    ) -> dict[str | None, tuple[list[str], int]]:
        """Each group's most-used models and its model count, in one grouped pass over the page's keys."""
        if not keys:
            return {}
        named = [key for key in keys if key is not None]
        in_page = [column.in_(named)] if named else []
        if None in keys:
            in_page.append(column.is_(None))
        requests = request_count(status)
        rows = (
            await self.db.execute(
                select(column, UsageLog.model, requests)
                .where(*conditions, or_(*in_page))
                .group_by(column, UsageLog.model)
                .order_by(requests.desc(), UsageLog.model)
            )
        ).all()
        models: dict[str | None, list[str]] = {}
        for key, model, _ in rows:
            models.setdefault(key, []).append(model)
        return {key: (names[:_GROUP_MODELS_SHOWN], len(names)) for key, names in models.items()}

    async def activity_groups(
        self,
        *,
        group_by: ActivityGroupBy,
        conditions: list[ColumnElement[bool]],
        status: str | None,
        search: str | None,
        order: ActivityGroupOrder,
        skip: int,
        limit: int,
    ) -> tuple[list[ActivityGroupRow], int]:
        """A page of the log's groups, and how many groups the filters leave.

        Absorbed attempts are in the rows aggregated and counted in ``absorbed``;
        ``requests`` and ``latency_ms`` leave them out, the way the summary totals do,
        except under ``status=absorbed``, where the attempts are what is counted.
        ``search`` keeps the groups whose value, or the name it resolves to, contains
        it (case-insensitive, ``%`` and ``_`` literal).
        """
        column, label_join = _GROUP_COLUMNS[group_by]
        if group_by == "alias":
            conditions = [*conditions, *_ALIASED]
        label = label_join.label if label_join is not None else null()
        # The page's keys already carry the search, so naming their models needs neither
        # it nor the label join it may read.
        unsearched = conditions
        term = (search or "").strip()
        if term:
            named = [column.icontains(term, autoescape=True)]
            if label_join is not None:
                named.append(label_join.label.icontains(term, autoescape=True))
            conditions = [*conditions, or_(*named)]
        served = UsageLog.status != "absorbed"
        counted = UsageLog.latency_ms if status == "absorbed" else case((served, UsageLog.latency_ms))
        requests = request_count(status)
        last_at = func.max(UsageLog.timestamp)
        stmt = select(
            column,
            label,
            requests,
            func.coalesce(func.sum(case((UsageLog.status == "error", 1), else_=0)), 0),
            func.coalesce(func.sum(case((UsageLog.status == "absorbed", 1), else_=0)), 0),
            func.coalesce(func.sum(UsageLog.cost), 0.0),
            func.coalesce(func.sum(case((not_served_here(UsageLog.source), UsageLog.cost), else_=0)), 0.0),
            billed_input_sum(),
            billed_output_sum(),
            func.coalesce(func.sum(billed_meter("cache_read_tokens", UsageLog.cache_read_tokens)), 0),
            func.coalesce(func.sum(counted), 0),
            func.min(UsageLog.timestamp),
            last_at,
        )
        groups_in_window = select(column)
        if label_join is not None:
            stmt = stmt.outerjoin(label_join.entity, label_join.on)
            # Only a search on the label needs it here; the join cannot change how
            # many groups there are.
            if term:
                groups_in_window = groups_in_window.outerjoin(label_join.entity, label_join.on)
        grouping = (column,) if label_join is None else (column, label)
        stmt = stmt.where(*conditions).group_by(*grouping)
        total = (
            await self.db.execute(
                select(func.count()).select_from(groups_in_window.where(*conditions).group_by(column).subquery())
            )
        ).scalar_one()
        ordering = (requests.desc(), column) if order == "requests" else (last_at.desc(), column)
        rows = (await self.db.execute(stmt.order_by(*ordering).offset(skip).limit(limit))).all()
        if group_by == "model":
            models = {row[0]: ([row[0]], 1) for row in rows}
        else:
            models = await self._group_models(column, [row[0] for row in rows], unsearched, status)
        return [
            ActivityGroupRow(
                key=row[0],
                label=row[1],
                requests=int(row[2]),
                errors=int(row[3]),
                absorbed=int(row[4]),
                cost=float(row[5]),
                imported_cost=float(row[6]),
                input_tokens=int(row[7]),
                output_tokens=int(row[8]),
                cache_read_tokens=int(row[9]),
                latency_ms=int(row[10]),
                first_at=row[11],
                last_at=row[12],
                models=models.get(row[0], ([], 0))[0],
                model_count=models.get(row[0], ([], 0))[1],
            )
            for row in rows
        ], total
