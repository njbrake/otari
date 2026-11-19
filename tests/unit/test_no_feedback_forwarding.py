"""Fork gate: nothing forwards a user's feedback to otari.ai.

Upstream ships in-product feedback on by default (otari#1676), relaying what a
dashboard user types to ``api.otari.ai``. This fork deletes it. Each check here
fails if an upstream sync restores a piece of it, so the merge that brings it
back cannot pass quietly.
"""

import importlib.util
from pathlib import Path

from gateway.core.config import GatewayConfig
from gateway.features import CORE_FEATURES

GATEWAY_ROOT = Path(__file__).resolve().parents[2] / "src" / "gateway"


def test_no_feedback_module_ships() -> None:
    for module in ("gateway.services.feedback", "gateway.api.routes.feedback"):
        assert importlib.util.find_spec(module) is None, f"{module} is back; delete it"


def test_no_feature_named_feedback() -> None:
    assert all(feature.name != "feedback" for feature in CORE_FEATURES)


def test_no_setting_turns_it_on() -> None:
    assert "feedback_enabled" not in GatewayConfig.model_fields


def test_no_source_names_the_receiver() -> None:
    hits = [
        f"{path.relative_to(GATEWAY_ROOT)}"
        for path in GATEWAY_ROOT.rglob("*.py")
        if "feedback/submissions" in path.read_text(encoding="utf-8")
    ]
    assert not hits, f"The otari.ai feedback receiver is named in: {hits}"
