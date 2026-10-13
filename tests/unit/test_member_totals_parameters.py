"""Every query parameter of a member's workspace-totals reads, classified.

A member who asks for a workspace's totals (``workspace_totals=true`` on the
organization usage summary, latency, tools, series and groups) may narrow and
split them only in ways that name no person, key or session. This holds each
query parameter of those five routes, read from the routes themselves, to one class:

* **allowlisted**: a filter the reader allows, ``MEMBER_TOTALS_FILTERS``;
* **refused**: a filter the reader refuses, with why;
* **breakdown**: judged by the dimensions it splits by
  (``MEMBER_TOTALS_BREAKDOWNS``), against ``MEMBER_TOTALS_DIMENSIONS``;
* **neutral**: shapes the answer without choosing whose rows it reads
  (``MEMBER_TOTALS_NEUTRAL``).

A parameter added to one of the routes fails here until it is classified, and
an entry naming a parameter that is gone fails too.
"""

import uuid
from collections.abc import Iterator
from dataclasses import fields

import pytest
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute

from gateway.api.routes._usage_common import UsageReadFilters
from gateway.api.routes.organization_usage import MEMBER_TOTALS_BREAKDOWNS, MEMBER_TOTALS_NEUTRAL, router
from gateway.core.usage_filters import UsageRefinements
from gateway.exceptions.organizations_exceptions import WorkspaceTotalsNarrowingError
from gateway.models.tenancy import Workspace
from gateway.services.organizations import MEMBER_TOTALS_FILTERS, WorkspaceReader

_ROUTES = (
    "/organizations/me/usage/summary",
    "/organizations/me/usage/latency",
    "/organizations/me/usage/tools",
    "/organizations/me/usage/series",
    "/organizations/me/usage/groups",
)

ALLOWLISTED = {
    "start_date",
    "end_date",
    "workspace_id",
    "status",
    "exclude_status",
    "status_code",
    "model",
    "exclude_model",
    "requested_model",
    "provider",
    "priced",
}

REFUSED = {
    "user_id": "names a person",
    "exclude_user_id": "names a person",
    "api_key_id": "names a key, which is a person's",
    "exclude_api_key_id": "names a key, which is a person's",
    "source": "a provenance source picks out a person's tooling",
    "exclude_source": "a provenance source picks out a person's tooling",
    "source_label": "names a session",
    "channel": "the Playground channel is a person at the dashboard",
    "exclude_channel": "the Playground channel is a person at the dashboard",
    "policy_name": "a routing policy can be one person's",
    "exclude_policy_name": "a routing policy can be one person's",
    "routed": "judged with the policy filters it stands beside",
    "is_null": "no key, user or session isolates the rows that have one",
    "tag": "a tag value can name a person or a team of one",
    "tool": "a tool can be one person's",
    "endpoint": "the Playground's endpoint is the Playground channel, a person at the dashboard",
    "counts_toward_budget": "rows that do not count are imported ones, which is a source",
    "q": "searches the request rows, prompts and names included",
    "tokens_gt": "a threshold can isolate one request, and so its sender",
    "cost_gt": "a threshold can isolate one request, and so its sender",
    "latency_ms_gt": "a threshold can isolate one request, and so its sender",
}

BREAKDOWN = {"dimensions", "group_by", "p95_by", "group_by_tag"}

NEUTRAL = {
    "bucket": "the time grain",
    "include_p95": "a latency figure over rows already allowed",
    "session_details": "adds only to the breakdown by session, which a member may not ask for",
    "rank_by": "the order of rows already allowed",
    "rank_order": "the order of rows already allowed",
    "search": "matches only values of the grouped dimension, the model for a member",
    "order": "the order of rows already allowed",
    "skip": "pagination",
    "limit": "pagination",
    "workspace_totals": "the ask itself",
}


def _query_parameters(dependant: Dependant) -> Iterator[str]:
    yield from (param.alias for param in dependant.query_params)
    for sub in dependant.dependencies:
        yield from _query_parameters(sub)


def _route_parameters() -> dict[str, set[str]]:
    found = {
        route.path: set(_query_parameters(route.dependant)) for route in router.routes if isinstance(route, APIRoute)
    }
    return {path: found[path] for path in _ROUTES}


def _filter_names() -> set[str]:
    """The names the route's ``_filters_set`` judges: the read filters' fields and the refinements."""
    read = {field.name for field in fields(UsageReadFilters) if field.name != "refine"}
    return read | set(UsageRefinements.model_fields)


def _member_reader() -> WorkspaceReader:
    shared = Workspace(name="Shared", organization_id=uuid.uuid4(), members_see_workspace_totals=True)
    return WorkspaceReader.of(shared, sees_everyone=False)


def test_the_classes_do_not_overlap() -> None:
    classes = [ALLOWLISTED, set(REFUSED), BREAKDOWN, set(NEUTRAL)]
    assert sum(len(c) for c in classes) == len(set().union(*classes))


@pytest.mark.parametrize("path", _ROUTES)
def test_every_query_parameter_is_classified(path: str) -> None:
    classified = ALLOWLISTED | set(REFUSED) | BREAKDOWN | set(NEUTRAL)
    unclassified = sorted(_route_parameters()[path] - classified)
    assert not unclassified, (
        f"{path} takes {unclassified}, which this test does not classify. Judge whether a member reading "
        "a workspace's totals may send it, and add it to ALLOWLISTED, REFUSED, BREAKDOWN or NEUTRAL "
        "(and to the matching constant in the route or the visibility service)."
    )


def test_no_entry_names_a_parameter_that_is_gone() -> None:
    every = set().union(*_route_parameters().values())
    stale = sorted((ALLOWLISTED | set(REFUSED) | BREAKDOWN | set(NEUTRAL)) - every)
    assert not stale


def test_the_classes_match_what_the_code_judges() -> None:
    assert ALLOWLISTED == MEMBER_TOTALS_FILTERS
    assert set(MEMBER_TOTALS_BREAKDOWNS) == BREAKDOWN
    assert set(NEUTRAL) == MEMBER_TOTALS_NEUTRAL
    # Every filter reaches the reader by name, so an allowlisted or refused one is judged at all.
    assert _filter_names() == ALLOWLISTED | set(REFUSED)


@pytest.mark.parametrize("name", sorted(ALLOWLISTED))
def test_an_allowlisted_filter_passes(name: str) -> None:
    _member_reader().require_totals(breakdowns=[], filters=[name])


@pytest.mark.parametrize("name", sorted(REFUSED))
def test_a_refused_filter_is_refused_by_name(name: str) -> None:
    with pytest.raises(WorkspaceTotalsNarrowingError, match=f"`{name}`"):
        _member_reader().require_totals(breakdowns=[], filters=[name])


@pytest.mark.parametrize(
    ("parameter", "value", "dimensions"),
    [
        ("dimensions", ["none", "model", "status_code"], ["model", "status_code"]),
        ("group_by", "provider", ["provider"]),
        ("p95_by", "user", ["user"]),
        ("group_by_tag", "team", ["tag"]),
    ],
)
def test_a_breakdown_is_read_as_the_dimensions_it_splits_by(
    parameter: str, value: object, dimensions: list[str]
) -> None:
    assert MEMBER_TOTALS_BREAKDOWNS[parameter](value) == dimensions
