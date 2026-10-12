"""The dashboard overview's summary.

Thin composition over ``gateway.services.overview.overview_service``, which
carries the reasoning: which caller sees which strip, and why the judgment
happens here rather than in the browser.

One endpoint for one page, which is unusual on this surface and deliberate. The
overview renders three integers and one worst-case row per strip, and answering
it from the list routes meant reading four whole tables to compute them
(otari#1425, under otari#1376).
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status

from gateway.api.deps import CurrentIdentity, OverviewServiceDep, verify_master_key
from gateway.schemas.overview import OverviewScope, OverviewSummaryResponse
from gateway.services.overview.overview_service import Month

# Authentication on the router for the reason ``admin.py`` declares it there:
# the one handler happens to take an identity today, and one that did not would
# be unauthenticated with nothing to notice. Authorization is not here, because
# this answers every signed-in caller and withholds per caller instead: the
# service decides which strip each one may see.
router = APIRouter(
    prefix="/overview",
    tags=["overview"],
    dependencies=[Depends(verify_master_key)],
)


def _month(value: str | None, now: datetime) -> Month:
    """The month asked for, or the current one. Raises ``ValueError`` for one that does not exist or has not started."""

    if value is None:
        return Month.current(now)
    year, number = int(value[:4]), int(value[5:])
    # Refused before it is built: a month past year 9999 has no end to build.
    if (year, number) > (now.year, now.month):
        raise ValueError(f"{value} has not started")
    if year < 1:
        raise ValueError(f"{value} is not a month")
    return Month.of(year, number, now)


@router.get("")
async def get_overview(
    service: OverviewServiceDep,
    current_identity: CurrentIdentity,
    workspace_id: Annotated[
        uuid.UUID | None,
        Query(description="Narrow the counts to one workspace of the caller's organization."),
    ] = None,
    month: Annotated[
        str | None,
        Query(
            pattern=r"^\d{4}-(0[1-9]|1[0-2])$",
            description=(
                "The calendar month whose spend and error rate to report, `YYYY-MM` in UTC. Defaults to the "
                "current month; a month that has not started is refused. Limit and expiry items, and each "
                "row's `limit_spent`, describe now whichever month is asked for."
            ),
        ),
    ] = None,
    scope: Annotated[
        OverviewScope,
        Query(
            description=(
                "Whose spend to read: the caller's own, the workspace's, or the organization's. "
                "A scope the caller may not read falls back to `you`; `scope` in the answer says which was used."
            )
        ),
    ] = "workspace",
) -> OverviewSummaryResponse:
    """Summarize what the dashboard overview shows beside its usage chart.

    The counts, the budget judgment, the needs-attention list and the limits
    rail in one answer, so the page does not read several collections to
    compute them. A workspace outside the caller's organization is treated as
    none given rather than refused, because the id comes from a switcher whose
    contents can go stale. A month after the current one is refused.
    """

    now = datetime.now(UTC)
    try:
        chosen = _month(month, now)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    summary = await service.summary(
        identity=current_identity, workspace_id=workspace_id, month=chosen, scope=scope, now=now
    )
    return OverviewSummaryResponse.model_validate(summary, from_attributes=True)
