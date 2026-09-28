"""Every no-pricing refusal the gateway writes names ``require_pricing``.

The dashboard's request detail tells a gateway refusal for a missing price apart
from a provider's own 402 (an exhausted account balance) by that word, since both
are recorded with status 402 and only the first is fixed by pricing the model
(see ``web/src/features/activity/ActivityPage.tsx``). Rewording a refusal without
it would send the dashboard's pricing guidance to the wrong rows.
"""

from gateway.api.routes._pipeline import UNPRICED_TOOL_DETAIL_TEMPLATE
from gateway.services.pricing_service import no_pricing_error_detail


def test_the_model_refusal_names_require_pricing() -> None:
    assert "require_pricing" in no_pricing_error_detail("openai:gpt-4o")


def test_the_tool_refusal_names_require_pricing() -> None:
    assert "require_pricing" in UNPRICED_TOOL_DETAIL_TEMPLATE.format(tool="web_search", key="otari:web_search")
