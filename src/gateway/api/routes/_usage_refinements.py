"""The refinement filters every usage read takes: exclusions, routing, thresholds, ways in, empty columns and search.

One dependency for the deployment-wide and the organization's usage routes, so
the list, its count, the summary, the series and the filter menus' values all
read a refinement the same way.
"""

from typing import Annotated, Literal, get_args

from fastapi import Depends, Query

from gateway.core.sql import MAX_FILTER_VALUES
from gateway.models.money import MAX_USD_LIMIT
from gateway.schemas.usage_and_telemetry import NullableUsageField, UsageChannel
from gateway.services.usage_and_telemetry import UsageRefinements

UsageStatus = Literal["success", "error", "absorbed", "incomplete"]
# The token and latency columns are 32-bit, so a larger threshold is refused here
# rather than overflowing the parameter in the database.
_MAX_INT32 = 2**31 - 1
_VALUES_CAP = f"At most {MAX_FILTER_VALUES} per call."
# Longest search a caller may send: far past a request id or a model name, and short
# enough that no caller posts a megabyte pattern into a LIKE over the window.
MAX_SEARCH_LENGTH = 200
SEARCH_DESC = (
    "Free-text search. A UUID matches a usage row id, an Otari-Request-ID or a user id exactly; anything else is a "
    "case-insensitive substring of the model that served, the model name the caller sent, the provenance "
    "source, the session label, the user id, the billed user's alias or the API key's name. "
    f"At most {MAX_SEARCH_LENGTH} characters. On the list and its count a substring search reads the "
    "window '/summary' does: the last 30 days when 'start_date' is omitted, and at most 366."
)


def _values(description: str) -> object:
    return Query(max_length=MAX_FILTER_VALUES, description=f"{description} {_VALUES_CAP}")


def usage_refinements(
    exclude_model: Annotated[list[str] | None, _values("Leave out rows served by these models.")] = None,
    exclude_user_id: Annotated[
        list[str] | None, _values("Leave out rows billed to these users; rows with no user stay.")
    ] = None,
    exclude_api_key_id: Annotated[
        list[str] | None, _values("Leave out rows made with these API keys; rows with no key stay.")
    ] = None,
    exclude_source: Annotated[list[str] | None, _values("Leave out rows from these provenance sources.")] = None,
    exclude_status: Annotated[
        list[UsageStatus] | None,
        Query(max_length=len(get_args(UsageStatus)), description="Leave out rows with these statuses."),
    ] = None,
    policy_name: Annotated[list[str] | None, _values("Only rows served through these routing policies.")] = None,
    exclude_policy_name: Annotated[
        list[str] | None, _values("Leave out rows served through these routing policies; unrouted rows stay.")
    ] = None,
    routed: Annotated[
        bool | None,
        Query(description="true: only requests a routing policy served; false: only requests that named a model."),
    ] = None,
    tokens_gt: Annotated[
        int | None,
        Query(ge=0, le=_MAX_INT32, description="Only rows billed for more than this many tokens (input plus output)."),
    ] = None,
    cost_gt: Annotated[
        float | None,
        Query(ge=0, le=MAX_USD_LIMIT, allow_inf_nan=False, description="Only rows that cost more than this many USD."),
    ] = None,
    latency_ms_gt: Annotated[
        int | None,
        Query(ge=0, le=_MAX_INT32, description="Only rows whose total latency exceeded this many milliseconds."),
    ] = None,
    statuses: Annotated[
        list[UsageStatus] | None,
        Query(
            max_length=len(get_args(UsageStatus)),
            description="Only rows with one of these statuses; repeatable. 'status' narrows to one.",
        ),
    ] = None,
    include_absorbed: Annotated[
        bool | None,
        Query(
            description=(
                "false leaves out the attempts a routing policy recovered from (status 'absorbed'), so each "
                "request is listed once, as the row that settled it. A status filter takes precedence."
            )
        ),
    ] = None,
    channel: Annotated[
        list[UsageChannel] | None,
        Query(
            max_length=len(get_args(UsageChannel)),
            description=(
                "Only rows that came in one of these ways: 'imported' through the external-events ingest, "
                "'playground' from the dashboard's Playground, 'api' any other request this deployment served."
            ),
        ),
    ] = None,
    is_null: Annotated[
        list[NullableUsageField] | None,
        Query(
            max_length=len(get_args(NullableUsageField)),
            description="Only rows where these are empty: 'api_key' (no key), 'user' (no billed user), 'session'.",
        ),
    ] = None,
    q: Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH, description=SEARCH_DESC)] = None,
) -> UsageRefinements:
    """The refinements a usage read was asked for, as query parameters."""
    return UsageRefinements(
        exclude_model=exclude_model,
        exclude_user_id=exclude_user_id,
        exclude_api_key_id=exclude_api_key_id,
        exclude_source=exclude_source,
        exclude_status=list(exclude_status) if exclude_status else None,
        policy_name=policy_name,
        exclude_policy_name=exclude_policy_name,
        routed=routed,
        tokens_gt=tokens_gt,
        cost_gt=cost_gt,
        latency_ms_gt=latency_ms_gt,
        statuses=list(statuses) if statuses else None,
        include_absorbed=include_absorbed,
        channel=list(channel) if channel else None,
        is_null=list(is_null) if is_null else None,
        q=q,
    )


UsageRefinementsQuery = Annotated[UsageRefinements, Depends(usage_refinements)]
