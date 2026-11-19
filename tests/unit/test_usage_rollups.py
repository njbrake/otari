"""The rollups keep a set of measures for every gateway-run tool the usage reads report."""

from gateway.models.usage import UsageRollup
from gateway.schemas.usage_and_telemetry import GATEWAY_TOOL_NAMES


def test_every_gateway_tool_has_its_rollup_measures() -> None:
    expected = {f"{tool}_{measure}" for tool in GATEWAY_TOOL_NAMES for measure in ("calls", "errors", "cost", "rows")}

    assert expected <= set(UsageRollup.__table__.c.keys())
