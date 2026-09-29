"""Tool names are caller-influenced, so the tally bounds what reaches the row."""

from gateway.services.tool_usage import OVERFLOW_TOOL_NAME, ToolUsageTally


def test_nul_is_stripped_from_tool_names() -> None:
    """PostgreSQL ``jsonb`` rejects ``\\u0000``, and one such key fails the row write."""
    tally = ToolUsageTally()
    tally.record_result("se\x00arch", "ok")
    tally.record_result("\x00", "ok")
    assert tally.billable_calls() == {"search": 1, OVERFLOW_TOOL_NAME: 1}
