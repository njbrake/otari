"""Response models of the dashboard overview."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from gateway.schemas.organizations import WorkspaceVisibility

# Which numbers the overview reads: the caller's own, one workspace's, or every
# workspace in the organization.
OverviewScope = Literal["you", "workspace", "organization"]

# What a needs-attention item is about. The page writes the words; this names the case.
AttentionKind = Literal[
    "provider_unreachable",
    "budget_over",
    "budget_near",
    "budget_pace",
    "key_over_limit",
    "key_near_limit",
    "key_expiring",
    "error_rate",
]


class WorstAllocationResponse(BaseModel):
    """The row furthest through its allowance."""

    budget_id: str
    name: str | None = Field(description="The row's own name, or null where nobody gave it one.")
    spent: float
    allocated: float
    scope_type: str | None = Field(
        description="What a spend ceiling caps (workspace, org_member, api_token, ...); null for a budget."
    )
    scope_id: str | None = Field(description="The scope's id, so an unnamed ceiling can be named after it.")


class AllocationHealthResponse(BaseModel):
    """One set of capped rows, reduced to what a strip renders."""

    over_count: int = Field(description="Rows at or past their allowance.")
    near_count: int = Field(description="Rows at 80% of their allowance or more, but not past it.")
    capped_count: int = Field(description="Rows with a finite cap, which are the ones that can be judged.")
    total_count: int = Field(
        description="Rows of any kind, so a caller can tell 'none configured' from 'none caps spend'."
    )
    worst: WorstAllocationResponse | None


class OverviewMonthResponse(BaseModel):
    """The UTC calendar month the overview reads."""

    start: datetime
    end: datetime = Field(description="The first instant of the next month; exclusive.")
    elapsed_days: int = Field(
        description="Days of the month passed so far, counting today; all of them for a past month."
    )
    days: int


class OverviewAttentionItemResponse(BaseModel):
    """One thing worth acting on now, for the caller's role, with the figures that make it so.

    Which fields are set depends on ``kind``: a limit carries ``used``, ``limit``
    and ``fraction``; ``key_expiring`` and ``budget_pace`` carry ``at`` (the
    expiry, or the day spend is projected to pass the limit), and
    ``provider_unreachable`` the time of the failed check; ``error_rate``
    carries ``count`` (failures) and ``fraction`` (of requests). Limit and
    expiry items describe now, whichever month was asked for.
    """

    kind: AttentionKind
    severity: Literal["alert", "warn"]
    subject_id: str | None = Field(description="The key, workspace or provider instance the item is about.")
    subject_name: str | None
    used: float | None = Field(
        default=None,
        description=(
            "USD spent against the limit in its current period. Null on a workspace budget item for a member "
            "of a workspace that keeps its totals from members, which still carries `limit` and `fraction`."
        ),
    )
    limit: float | None = Field(default=None, description="The limit, in USD.")
    fraction: float | None = None
    at: datetime | None = None
    count: int | None = None


class OverviewLimitRowResponse(BaseModel):
    """One key or workspace in the overview's rail: what it billed this month, and what limits it."""

    id: str
    name: str | None
    owner_name: str | None = Field(description="The key's billed user, as the roster names them; null for a workspace.")
    is_mine: bool = Field(description="A key billed to the caller; false for a workspace.")
    spent: float = Field(description="Billed spend in the month, in USD: cost less imported usage.")
    limit: float | None = Field(
        description="The USD cap of the key's or workspace's spend ceiling; null when uncapped."
    )
    limit_spent: float | None = Field(
        description=(
            "What the ceiling counts now in its current period, holds included, whichever month was asked for; "
            "null when uncapped."
        )
    )
    period_end: datetime | None = Field(description="When the ceiling's period resets; null when it never does.")
    last_used_at: datetime | None = Field(
        description="A key's last use; a workspace's last request in the month asked for. Null when there is none."
    )
    expires_at: datetime | None
    is_subscription: bool = Field(description="Everything this key recorded in the month was imported usage.")


class OverviewLimitsResponse(BaseModel):
    """The rail: the caller's keys, a workspace's keys, or the organization's workspaces.

    At most eight, most billed first. Empty for a member reading a workspace's
    totals, because the workspace's keys are other people's.
    """

    kind: Literal["keys", "workspaces"]
    rows: list[OverviewLimitRowResponse]


class OverviewSummaryResponse(BaseModel):
    """What the dashboard overview renders beside its usage chart.

    ``budgets`` and ``ceilings`` are null where the caller may not see them,
    which is not the same as a strip with nothing in it: deployment budgets are
    the operator's, and spend ceilings are an organization owner's or admin's.
    ``attention`` and ``limits`` are always present, for the ``scope`` used.
    """

    active_keys: int
    active_members: int = Field(description="Active members of the named workspace; 0 when none is named.")
    budgets: AllocationHealthResponse | None
    ceilings: AllocationHealthResponse | None
    month: OverviewMonthResponse
    scope: OverviewScope = Field(
        description="The scope read, after falling back to 'you' where the asked one is not allowed."
    )
    attention: list[OverviewAttentionItemResponse] = Field(description="Most severe first.")
    limits: OverviewLimitsResponse
    visibility: WorkspaceVisibility | None = Field(
        description=(
            "What the named workspace shows members who do not manage it; null when no workspace is named. "
            "A member reading the workspace scope of one that shares its totals sees them and an empty rail."
        )
    )
