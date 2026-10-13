"""The hourly usage rollups keep a set of tool measures for every tool the usage reads enumerate."""

from gateway.models.usage import UsageRollup
from gateway.repositories.usage.usage_rollup_repository import ROLLUP_TOOLS
from gateway.services.usage import GATEWAY_TOOL_NAMES


def test_the_rollups_keep_measures_for_every_gateway_tool() -> None:
    """The tool read sums ``<tool>_calls`` and its siblings off the rollups for each of these names."""
    assert set(ROLLUP_TOOLS) == set(GATEWAY_TOOL_NAMES)
    columns = set(UsageRollup.__table__.c.keys())
    for tool in GATEWAY_TOOL_NAMES:
        assert {f"{tool}_calls", f"{tool}_errors", f"{tool}_cost", f"{tool}_rows"} <= columns
