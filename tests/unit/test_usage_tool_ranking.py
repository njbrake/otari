"""The tool breakdown ranks spend to the micro-dollar, so float noise in a sum never reorders it."""

import pytest

from gateway.schemas.usage import UsageToolRow
from gateway.services.usage import by_spend


def _row(tool: str, cost: float) -> UsageToolRow:
    return UsageToolRow(tool=tool, calls=1, errors=0, requests=1, cost=cost)


@pytest.mark.parametrize(
    ("code_execution", "web_search"),
    [
        # The same 0.15 summed in two orders: either side may carry the last bit.
        (0.1 + 0.05, 0.15),
        (0.15, 0.1 + 0.05),
    ],
)
def test_equal_spends_rank_by_name_whichever_carries_the_noise(code_execution: float, web_search: float) -> None:
    assert code_execution != web_search
    ranked = by_spend([_row("web_search", web_search), _row("code_execution", code_execution), _row("web_fetch", 0.1)])
    assert [row.tool for row in ranked] == ["code_execution", "web_search", "web_fetch"]


def test_a_bigger_spend_still_ranks_first() -> None:
    ranked = by_spend([_row("code_execution", 0.149999), _row("web_search", 0.15)])
    assert [row.tool for row in ranked] == ["web_search", "code_execution"]
