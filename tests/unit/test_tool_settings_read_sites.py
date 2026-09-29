"""The tool read sites resolve from config (so a dashboard override
hot-applies), not only from the environment. Guards against a normalization that
mutates config but never reaches the request path (eng T3)."""

import pytest

from gateway.api.routes._tools import (
    _build_web_search_backend,
    _resolve_sandbox_purpose_hint,
    _resolve_web_search_purpose_hint,
)
from gateway.core.config import GatewayConfig


def test_build_web_search_backend_reads_config_knobs() -> None:
    config = GatewayConfig(
        web_search_engines="google,bing",
        web_search_max_results=3,
        web_search_extract=False,
    )
    backend = _build_web_search_backend(base_url="http://searxng:8080", tool_entry={}, config=config)
    assert backend._engines == ("google", "bing")
    assert backend._max_results == 3
    assert backend._extract_content is False


def test_build_web_search_backend_config_overrides_env(monkeypatch: pytest.MonkeyPatch) -> None:
    # A config value (a dashboard override applied to config) wins over the env var.
    monkeypatch.setenv("OTARI_WEB_SEARCH_MAX_RESULTS", "9")
    config = GatewayConfig(web_search_max_results=2)
    backend = _build_web_search_backend(base_url="http://x:8080", tool_entry={}, config=config)
    assert backend._max_results == 2


def test_build_web_search_backend_env_fallback_when_config_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pure-env deployment: no config value, env still honored (byte-for-byte prior behavior).
    monkeypatch.setenv("OTARI_WEB_SEARCH_MAX_RESULTS", "4")
    config = GatewayConfig()
    config.web_search_max_results = None
    backend = _build_web_search_backend(base_url="http://x:8080", tool_entry={}, config=config)
    assert backend._max_results == 4


def test_resolve_purpose_hints_from_config() -> None:
    config = GatewayConfig(sandbox_purpose_hint="sbx", web_search_purpose_hint="ws")
    assert _resolve_sandbox_purpose_hint(None, config) == "sbx"
    assert _resolve_web_search_purpose_hint(None, config) == "ws"


def test_sandbox_image_reads_config_first() -> None:
    config = GatewayConfig(sandbox_session_image="ghcr.io/acme/sandbox:2")
    assert config.effective_sandbox_image() == "ghcr.io/acme/sandbox:2"


def test_sandbox_image_falls_back_to_env_when_the_override_is_cleared(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clearing a dashboard override must land on the configured value, not on nothing."""
    monkeypatch.setenv("OTARI_SANDBOX_SESSION_IMAGE", "mzdotai/otari-sandbox-container:latest")
    config = GatewayConfig()
    config.sandbox_session_image = None
    assert config.effective_sandbox_image() == "mzdotai/otari-sandbox-container:latest"
    # And the cleared value is still what a workspace may pin.
    assert config.pinnable_sandbox_images() == ("mzdotai/otari-sandbox-container:latest",)

