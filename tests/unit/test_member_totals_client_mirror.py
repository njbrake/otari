"""The dashboard's copy of what a member may ask of a workspace's shared totals matches the server's.

``web/src/features/workspaces/memberVisibility.ts`` mirrors the two allowlists in
``services/organizations/_visibility.py`` so the Usage page never offers a split
or a filter the server would refuse. A name on one side only fails here: dropped
from the server alone, a member's Workspace read is refused with 403; added to
the server alone, the page goes on hiding something it may show.
"""

import re
from pathlib import Path

from gateway.services.organizations import MEMBER_TOTALS_DIMENSIONS, MEMBER_TOTALS_FILTERS

_CLIENT = Path(__file__).resolve().parents[2] / "web/src/features/workspaces/memberVisibility.ts"


def _client_list(name: str) -> list[str]:
    """The string literals in the client constant ``name``'s initializer, in order."""
    source = _CLIENT.read_text()
    match = re.search(rf"export const {name}\b[^=]*=\s*(?:new Set\()?\[(?P<body>[^\]]*)\]", source)
    assert match, f"{name} is not a literal list in {_CLIENT.name}"
    return re.findall(r'"([^"]+)"', match.group("body"))


def test_the_client_offers_the_breakdowns_the_server_allows() -> None:
    assert _client_list("MEMBER_TOTALS_DIMENSIONS") == list(MEMBER_TOTALS_DIMENSIONS)


def test_the_client_sends_the_filters_the_server_allows() -> None:
    client = _client_list("MEMBER_TOTALS_FILTERS")
    assert len(client) == len(set(client))
    assert set(client) == MEMBER_TOTALS_FILTERS
