"""What the usage summary computes: which breakdowns, how many rows each keeps, and the fold."""

from gateway.schemas.usage import BreakdownDimension, SeriesGroupBy, UsageSeriesGroup, UsageSeriesPoint, UsageTotals
from gateway.services.sandbox_backend import CODE_EXECUTION_TOOL_NAME
from gateway.services.web_retrieval_backend import WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME

# The gateway-run tools that can be enumerated for a filter or a breakdown. MCP
# tool names come from a caller-supplied server, so they are unbounded and appear
# only in a row's own detail, never as a dimension of their own. The ``any``
# selector still matches them, because it tests the meter namespace itself.
GATEWAY_TOOL_NAMES: tuple[str, ...] = (
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    CODE_EXECUTION_TOOL_NAME,
)

# How many rows each breakdown returns before the remainder is folded into a
# single synthesized "other" row (so the tables still reconcile with the totals).
# Also caps the failure taxonomy's distinct codes, which no real window reaches
# (HTTP has far fewer), so that one is not folded.
BREAKDOWN_TOP_N = 100

# Sessions (``source_label``) are an order of magnitude higher-cardinality than
# models or users: one agent workload can open hundreds of them in a month, and
# the interesting signal is a long-ish head ("which tasks burned the budget"),
# not just the top few. Give that dimension a deeper cap so the head is not
# swallowed by the "other" fold.
_SESSION_BREAKDOWN_TOP_N = 250

# Every breakdown ``/summary`` can compute, and its top-N cap.
SUMMARY_BREAKDOWNS: dict[BreakdownDimension, int] = {
    "model": BREAKDOWN_TOP_N,
    "user": BREAKDOWN_TOP_N,
    "api_key": BREAKDOWN_TOP_N,
    "source": BREAKDOWN_TOP_N,
    "source_label": _SESSION_BREAKDOWN_TOP_N,
    "endpoint": BREAKDOWN_TOP_N,
    "provider": BREAKDOWN_TOP_N,
    "policy": BREAKDOWN_TOP_N,
    "workspace": BREAKDOWN_TOP_N,
    "channel": BREAKDOWN_TOP_N,
}

# The failure taxonomy (``errors_by_status_code``) is a GROUP BY pass like the
# breakdowns above, but it groups failures by status code rather than spend by a
# dimension, so it is selectable by name without being one of them. It is the
# one dimension whose response field is not ``by_<name>``.
ERROR_TAXONOMY_DIMENSION = "status_code"
TOOL_DIMENSION = "tool"
ALL_SUMMARY_DIMENSIONS: set[str] = set(SUMMARY_BREAKDOWNS) | {ERROR_TAXONOMY_DIMENSION, TOOL_DIMENSION}

# The breakdown each grouped series splits by.
SERIES_BREAKDOWNS: dict[SeriesGroupBy, BreakdownDimension] = {
    "model": "model",
    "user_id": "user",
    "api_key_id": "api_key",
    "source": "source",
    "source_label": "source_label",
    "channel": "channel",
    "provider": "provider",
    "policy": "policy",
    "workspace": "workspace",
}


def with_fold[R: UsageSeriesGroup](rows: list[R], totals: UsageTotals, *, row_type: type[R]) -> list[R]:
    """Append the synthesized ``other`` row for the groups the ranking left out, derived from the grand totals.

    So a capped breakdown always reconciles with the tiles, whichever way it was
    ranked. ``row_type`` builds the fold as the kind of row its breakdown lists.
    """
    seen_requests = sum(r.requests for r in rows)
    # request_count is an exact integer, so a positive residual is the reliable
    # signal that groups were folded; cost/tokens residuals follow from totals.
    residual_requests = totals.request_count - seen_requests
    if residual_requests <= 0:
        return rows
    billed_total = totals.billed_input_tokens + totals.billed_output_tokens
    return [
        *rows,
        row_type(
            key=None,
            cost=totals.cost - sum(r.cost for r in rows),
            tokens=billed_total - sum(r.tokens for r in rows),
            requests=residual_requests,
            is_other=True,
            imported_cost=totals.imported_cost - sum(r.imported_cost for r in rows),
            error_count=totals.error_count - sum(r.error_count for r in rows),
            cache_read_tokens=totals.billed_cache_read_tokens - sum(r.cache_read_tokens for r in rows),
        ),
    ]


def empty_usage_point(bucket_start: str) -> UsageSeriesPoint:
    return UsageSeriesPoint(bucket_start=bucket_start, cost=0.0, tokens=0, requests=0)
