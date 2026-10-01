"""The query parameters the usage reads share, and the conditions they become.

``usage.py`` (deployment-wide) and ``organization_usage.py`` (one tenant's rows)
serve the same reads over different scopes. Their filters are declared once here,
as dependency dataclasses, so the two surfaces cannot accept different filters or
publish different descriptions for the same one.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Literal

from fastapi import Depends, Query

from gateway.core.sql import MAX_FILTER_VALUES, match_any, utc_bound
from gateway.core.usage_filters import (
    MAX_COST_THRESHOLD,
    MAX_INT32,
    MAX_NULLABLE_FIELDS,
    MAX_SEARCH_LENGTH,
    MAX_STATUSES,
    NullableUsageField,
    UsageCondition,
    UsageRefinements,
    UsageStatus,
    needs_pricing_condition,
    refinement_conditions,
    tool_used_condition,
    usage_search_condition,
)
from gateway.models.usage import UsageLog
from gateway.services.sandbox_backend import CODE_EXECUTION_TOOL_NAME
from gateway.services.web_retrieval_backend import WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME

# How many request groups one call may ask for. The dashboard batches the groups
# visible on a page of the activity log into a single lookup, so the bound tracks
# the largest page size (1000) rather than a plan's candidate count; it exists to
# keep a caller from posting an unbounded IN list.
MAX_REQUEST_GROUPS = 1000

# The gateway-run tools that can be enumerated for a filter or a breakdown. MCP
# tool names come from a caller-supplied server, so they are unbounded and appear
# only in a row's own detail, never as a dimension of their own. The ``any``
# selector still matches them, because it tests the meter namespace itself.
GATEWAY_TOOL_NAMES: tuple[str, ...] = (
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    CODE_EXECUTION_TOOL_NAME,
)
ToolFilter = Literal["any", "web_search", "web_fetch", "code_execution"]

# Only the summary's own series also takes five minutes; see ``usage.Bucket``.
SUMMARY_BUCKET_DESC = (
    "Time-series granularity: '5min', 'hour' or 'day'. '5min' needs an explicit window of at most "
    "1000 buckets (about 83 hours); the default 30-day window is refused with a 422."
)
START_DESC = "Return logs with timestamp >= start_date (ISO 8601 or Unix epoch seconds)"
END_DESC = "Return logs with timestamp < end_date (ISO 8601 or Unix epoch seconds)"
STATUS_DESC = (
    "Filter to a single status: 'success', 'error', or 'absorbed' (an attempt a routing policy "
    "recovered from, excluded from error_count and request_count)"
)
STATUS_CODE_DESC = (
    "Filter to a single failure status code (e.g. 429 for provider rate limits, "
    "402 for missing-pricing rejections). Only error rows carry one, so this "
    "filter also restricts to status='error' unless 'status' is given explicitly"
)
ENDPOINT_DESC = "Filter to a single endpoint (e.g. '/v1/chat/completions')"
PROVIDER_DESC = "Filter to a single provider (e.g. 'openai')"
SOURCE_DESC = "Filter to a single provenance source (e.g. 'gateway' or 'claude_code')"
SOURCE_LABEL_DESC = "Filter to a single session/project label (the source_label carried by imported usage)"
REQUEST_GROUP_DESC = (
    "Filter to the rows of one or more request groups; repeatable "
    "(request_group_id=a&request_group_id=b). A routed request writes one row per "
    "attempt, all sharing a request_group_id, so this returns a request's whole plan: "
    "its absorbed attempts and the attempt that served it. Ignore ordering by "
    "timestamp and read attempt_position to reconstruct the plan. At most "
    f"{MAX_REQUEST_GROUPS} ids per call."
)
PRICED_DESC = (
    "Filter by token-pricing state: true = only rows whose model tokens were priced, "
    "false = only rows that still need pricing (no cost at all, or tokens that were "
    "never metered because the model had no rate). A row charged only for gateway-run "
    "tool calls still counts as needing pricing."
)
TOOL_DESC = (
    "Filter to requests that ran a gateway-run tool. 'any' matches any tool; a tool "
    f"name ({', '.join(GATEWAY_TOOL_NAMES)}) matches that tool specifically."
)
COUNTS_DESC = (
    "Filter by budget participation, which is not the same question as provenance: "
    "true = only enforced gateway rows, false = every row that never touches a budget, "
    "meaning imported usage and also gateway traffic on a budget-exempt key"
)
# The deployment-wide count alone narrows the false case further, so it cannot publish
# the description above: there it would promise the rows this count is what excludes.
COUNT_COUNTS_DESC = (
    "Filter by budget participation: true = only enforced gateway rows, false = only "
    "imported rows, narrowed past the filter of the same name on GET /api/v1/usage so the "
    "total matches what bulk delete and set-price can reach"
)
WORKSPACE_DESC = "Only usage recorded in this workspace."
# The three entity filters are repeatable on every usage endpoint, so a chart or a
# log view can compare a handful of models / users / keys instead of one at a time.
# The bulk delete / set-price selection body takes the same form (see
# UsageSelection): "all N matching" is counted over these filters and re-derived
# from that body, so a filter one side could not express would target a different
# set of rows than the operator was shown.
USER_MULTI_DESC = (
    "Filter to one or more users; repeatable (user_id=a&user_id=b). Several values match any of "
    f"them. At most {MAX_FILTER_VALUES} per call."
)
MODEL_MULTI_DESC = (
    "Filter to one or more models; repeatable (model=a&model=b). Several values match any of them. "
    f"At most {MAX_FILTER_VALUES} per call."
)
API_KEY_MULTI_DESC = (
    "Filter to one or more API key ids; repeatable (api_key_id=a&api_key_id=b). Several values "
    f"match any of them. At most {MAX_FILTER_VALUES} per call."
)
DIMENSIONS_DESC = (
    "Which breakdowns to compute; repeatable (dimensions=model&dimensions=user). Each value names the "
    "'by_<value>' response field it fills, except 'status_code', which fills the failure taxonomy in "
    "'errors_by_status_code'. Omit for every breakdown (the default); pass 'none' for a "
    "totals-and-series-only response. Each dimension left out skips one GROUP BY scan, so a caller that "
    "reads only the tiles or the time series should say so. Fields that were not requested come back empty."
)
SEARCH_DESC = (
    "Free-text search. An Otari-Request-ID or a usage row id matches exactly; otherwise a "
    "case-insensitive substring of the served model, the model name the caller sent, the session "
    f"label, the API key's name, or the billed user's alias. At most {MAX_SEARCH_LENGTH} characters. "
    "A substring search reads the window '/summary' does: the last 30 days when 'start_date' is omitted, "
    "and at most 366."
)
ROW_ID_DESC = f"Look up usage rows by row id; repeatable (id=a&id=b). At most {MAX_FILTER_VALUES} per call."
REQUEST_ID_DESC = (
    "Filter to the rows of one or more requests by the Otari-Request-ID their caller was sent; "
    "repeatable. A routed request's attempts share one. "
    f"At most {MAX_FILTER_VALUES} per call."
)
REQUESTED_MODEL_DESC = (
    "Filter to one or more model names as the caller sent them, before an alias or routing policy "
    "resolved them; repeatable. Rows written before the name was recorded carry none and never match. "
    f"At most {MAX_FILTER_VALUES} per call."
)
INCLUDE_ABSORBED_DESC = (
    "Whether the rows of a routed request's earlier failed attempts (status 'absorbed') are listed. "
    "Defaults to true. With false, each request appears once, as the row that settled it, and "
    "that row's 'absorbed_attempts' counts its earlier failed attempts. An explicit 'status' "
    "filter takes precedence."
)
INCLUDE_P95_DESC = "Also compute 'totals.p95_latency_ms', which sorts the window's latencies."
GROUP_BY_DESC = (
    "Collapse the log to one row per API key, session (source_label), model, billed user, routing policy, "
    "or alias: the name the caller sent (requested_model) where it named neither the model that served "
    "nor the policy. 'alias' leaves out the rows that used none."
)
SORT_DESC = (
    "Order rows by this column; ties fall back to newest first. 'source' is the API key's name (or the "
    "provenance source when there is no key), 'member' the billed user's alias, 'status' ranks failures, "
    "then earlier failed attempts and the requests served after one, then successes. Rows with no cost, "
    "latency, member or policy sort last in either direction. Any order but time sorts every row in "
    "the window, so it takes the window '/summary' does: the last 30 days when 'start_date' is omitted, "
    "and at most 366."
)
ORDER_DESC = "Sort direction."
COUNT_SORT_DESC = (
    "The order the list beside this count was read in. Any order but time bounds the window as the list's "
    "does, so the total is the total of its pages."
)
GROUP_SEARCH_DESC = (
    "Keep the groups whose value, or the name it resolves to (a key's name, a member's alias), contains this, "
    f"case-insensitive. What a column's filter menu searches. At most {MAX_SEARCH_LENGTH} characters."
)
GROUP_ORDER_DESC = "'recent' lists the most recently active group first; 'requests' the busiest."

_VALUES_CAP = f"At most {MAX_FILTER_VALUES} per call."


def usage_refinements(
    exclude_model: Annotated[
        list[str] | None,
        Query(max_length=MAX_FILTER_VALUES, description=f"Leave out rows served by these models. {_VALUES_CAP}"),
    ] = None,
    exclude_user_id: Annotated[
        list[str] | None,
        Query(
            max_length=MAX_FILTER_VALUES,
            description=f"Leave out rows billed to these users; rows with no user stay. {_VALUES_CAP}",
        ),
    ] = None,
    exclude_api_key_id: Annotated[
        list[str] | None,
        Query(
            max_length=MAX_FILTER_VALUES,
            description=f"Leave out rows made with these API keys; rows with no key stay. {_VALUES_CAP}",
        ),
    ] = None,
    exclude_source: Annotated[
        list[str] | None,
        Query(max_length=MAX_FILTER_VALUES, description=f"Leave out rows from these provenance sources. {_VALUES_CAP}"),
    ] = None,
    exclude_status: Annotated[
        list[UsageStatus] | None, Query(max_length=MAX_STATUSES, description="Leave out rows with these statuses.")
    ] = None,
    policy_name: Annotated[
        list[str] | None,
        Query(
            max_length=MAX_FILTER_VALUES, description=f"Only rows served through these routing policies. {_VALUES_CAP}"
        ),
    ] = None,
    exclude_policy_name: Annotated[
        list[str] | None,
        Query(
            max_length=MAX_FILTER_VALUES,
            description=f"Leave out rows served through these routing policies; unrouted rows stay. {_VALUES_CAP}",
        ),
    ] = None,
    routed: Annotated[
        bool | None,
        Query(description="true: only requests a routing policy served; false: only requests that named a model."),
    ] = None,
    is_null: Annotated[
        list[NullableUsageField] | None,
        Query(
            max_length=MAX_NULLABLE_FIELDS,
            description="Only rows where these columns are empty (no key, user or session).",
        ),
    ] = None,
    tokens_gt: Annotated[
        int | None,
        Query(ge=0, le=MAX_INT32, description="Only rows billed for more than this many tokens (input plus output)."),
    ] = None,
    cost_gt: Annotated[
        float | None,
        Query(
            ge=0,
            le=MAX_COST_THRESHOLD,
            allow_inf_nan=False,
            description="Only rows that cost more than this many USD.",
        ),
    ] = None,
    latency_ms_gt: Annotated[
        int | None,
        Query(ge=0, le=MAX_INT32, description="Only rows whose total latency exceeded this many milliseconds."),
    ] = None,
) -> UsageRefinements:
    """The shared refinement filters, as query parameters every usage read takes.

    Each bound restates ``UsageRefinements``'s, so a value the query layer admits
    always builds the model rather than failing inside the dependency.
    """
    return UsageRefinements(
        exclude_model=exclude_model,
        exclude_user_id=exclude_user_id,
        exclude_api_key_id=exclude_api_key_id,
        exclude_source=exclude_source,
        exclude_status=exclude_status,
        policy_name=policy_name,
        exclude_policy_name=exclude_policy_name,
        routed=routed,
        is_null=is_null,
        tokens_gt=tokens_gt,
        cost_gt=cost_gt,
        latency_ms_gt=latency_ms_gt,
    )


@dataclass
class UsageReadFilters:
    """The filters every usage read takes, as query parameters (``Annotated[..., Depends()]``)."""

    refine: Annotated[UsageRefinements, Depends(usage_refinements)]
    start_date: Annotated[datetime | None, Query(description=START_DESC)] = None
    end_date: Annotated[datetime | None, Query(description=END_DESC)] = None
    user_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=USER_MULTI_DESC)] = None
    status: Annotated[str | None, Query(description=STATUS_DESC)] = None
    status_code: Annotated[int | None, Query(description=STATUS_CODE_DESC)] = None
    model: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=MODEL_MULTI_DESC)] = None
    endpoint: Annotated[str | None, Query(description=ENDPOINT_DESC)] = None
    provider: Annotated[str | None, Query(description=PROVIDER_DESC)] = None
    source: Annotated[str | None, Query(description=SOURCE_DESC)] = None
    source_label: Annotated[str | None, Query(description=SOURCE_LABEL_DESC)] = None
    api_key_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=API_KEY_MULTI_DESC)] = None
    priced: Annotated[bool | None, Query(description=PRICED_DESC)] = None
    tool: Annotated[ToolFilter | None, Query(description=TOOL_DESC)] = None
    counts_toward_budget: Annotated[bool | None, Query(description=COUNTS_DESC)] = None
    workspace_id: Annotated[uuid.UUID | None, Query(description=WORKSPACE_DESC)] = None
    q: Annotated[str | None, Query(max_length=MAX_SEARCH_LENGTH, description=SEARCH_DESC)] = None
    requested_model: Annotated[
        list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=REQUESTED_MODEL_DESC)
    ] = None

    def conditions(
        self,
        *,
        start_date: datetime | None,
        end_date: datetime | None,
        scope: UsageCondition | None,
    ) -> list[UsageCondition]:
        """The WHERE conditions these filters select over the window the route resolved.

        Keeping this in one place is what makes the paginator's total (``/count``)
        match the rows the list returns. One condition sits outside it: the
        deployment-wide count also narrows ``counts_toward_budget=false`` to imported
        rows, because that call sizes a mutation rather than a page (see its docstring).

        ``scope`` is the one condition that is not a filter. The deployment-wide
        routes pass ``None`` and read every row; the organization-scoped routes pass
        the predicate their caller's membership resolved to, so it is ANDed in
        alongside whatever the client asked for and a client-supplied
        ``workspace_id`` can only ever narrow it further.

        Deliberately **without a default**. It is a parameter so that a route building
        these conditions cannot forget the half that makes them safe, and a default is
        what would let it: the forgotten case reads every tenant's rows and says
        nothing. Required, a new scoped route that omits it is a ``TypeError`` rather
        than a cross-tenant read in production.

        Bounds are pinned to UTC here rather than only in ``resolve_window``, which
        the summary endpoints route through but the list and count endpoints do not:
        an offset-less bound would otherwise resolve against the process's local
        timezone, so the same query would size a different set of rows per deployment.
        """
        conditions: list[UsageCondition] = []
        if scope is not None:
            conditions.append(scope)
        if self.workspace_id is not None:
            conditions.append(UsageLog.workspace_id == self.workspace_id)
        if start_date is not None:
            conditions.append(UsageLog.timestamp >= utc_bound(start_date))
        if end_date is not None:
            conditions.append(UsageLog.timestamp < utc_bound(end_date))
        if self.user_id is not None and self.user_id != []:
            conditions.append(match_any(UsageLog.user_id, self.user_id))
        if self.status is not None:
            conditions.append(UsageLog.status == self.status)
        if self.status_code is not None:
            conditions.append(UsageLog.status_code == self.status_code)
            if self.status is None:
                # Only a failure carries a status code (see ``UsageLog.status_code``),
                # so a bare code filter means "these failures" rather than "whatever
                # rows happen to hold this code": it stays error-scoped even if a
                # future write path starts stamping a code on a non-error row, and it
                # is served by the (status, timestamp) index instead of scanning the
                # window. An explicit ``status`` wins, so the combination stays a
                # literal query rather than a silently contradictory one.
                conditions.append(UsageLog.status == "error")
        if self.model is not None and self.model != []:
            conditions.append(match_any(UsageLog.model, self.model))
        if self.endpoint is not None:
            conditions.append(UsageLog.endpoint == self.endpoint)
        if self.provider is not None:
            conditions.append(UsageLog.provider == self.provider)
        if self.source is not None:
            conditions.append(UsageLog.source == self.source)
        if self.source_label is not None:
            conditions.append(UsageLog.source_label == self.source_label)
        if self.api_key_id is not None and self.api_key_id != []:
            conditions.append(match_any(UsageLog.api_key_id, self.api_key_id))
        if self.priced is True:
            conditions.append(~needs_pricing_condition())
        elif self.priced is False:
            conditions.append(needs_pricing_condition())
        if self.tool is not None:
            conditions.append(tool_used_condition(self.tool))
        if self.counts_toward_budget is not None:
            conditions.append(UsageLog.counts_toward_budget.is_(self.counts_toward_budget))
        if self.requested_model:
            conditions.append(match_any(UsageLog.requested_model, self.requested_model))
        if self.q is not None and (search := usage_search_condition(self.q)) is not None:
            conditions.append(search)
        conditions.extend(refinement_conditions(self.refine))
        return conditions


@dataclass
class UsageListFilters(UsageReadFilters):
    """The read filters plus the ones only a list of rows, and its count, take."""

    request_group_id: Annotated[
        list[str] | None, Query(max_length=MAX_REQUEST_GROUPS, description=REQUEST_GROUP_DESC)
    ] = None
    row_id: Annotated[list[str] | None, Query(alias="id", max_length=MAX_FILTER_VALUES, description=ROW_ID_DESC)] = None
    request_id: Annotated[list[str] | None, Query(max_length=MAX_FILTER_VALUES, description=REQUEST_ID_DESC)] = None
    include_absorbed: Annotated[bool, Query(description=INCLUDE_ABSORBED_DESC)] = True

    def conditions(
        self,
        *,
        start_date: datetime | None,
        end_date: datetime | None,
        scope: UsageCondition | None,
    ) -> list[UsageCondition]:
        conditions = super().conditions(start_date=start_date, end_date=end_date, scope=scope)
        if self.request_group_id:
            # A one-id lookup stays an equality test so it uses the index the same way
            # a single-row fetch would; the IN form is for the dashboard's batched
            # page lookup.
            conditions.append(match_any(UsageLog.request_group_id, self.request_group_id))
        if self.row_id:
            conditions.append(match_any(UsageLog.id, self.row_id))
        if self.request_id:
            conditions.append(match_any(UsageLog.request_id, self.request_id))
        if not self.include_absorbed and self.status is None:
            # An explicit status wins, so ``status=absorbed`` still lists the attempts
            # rather than being contradicted into an empty page.
            conditions.append(UsageLog.status != "absorbed")
        return conditions


@dataclass
class UsageCountFilters(UsageListFilters):
    """The list filters as the deployment-wide count publishes them; see :data:`COUNT_COUNTS_DESC`."""

    counts_toward_budget: Annotated[bool | None, Query(description=COUNT_COUNTS_DESC)] = None
