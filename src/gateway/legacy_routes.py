"""Serve the pre-0.6 request paths on the routes that replaced them.

v0.6.0 moved the API from ``/v1`` to ``/api/v1``, the health probes from
``/health`` to ``/api/v1/health``, and OTLP ingest from ``/v1/{traces,logs,metrics}``
to ``/otlp/v1/...``, with no redirect. Clients configured against the old paths
(an OpenAI-style base URL of ``{origin}/v1``, an Anthropic-style one of
``{origin}``, an exporter pointed at ``{origin}``) keep working because each move
was a prefix insertion, so the old path plus a prefix is the new one.
"""

from starlette.types import ASGIApp, Receive, Scope, Send

from gateway.core.config import API_ROOT, OTLP_ROOT

_LEGACY_ROOT = "/v1"
_LEGACY_HEALTH = "/health"
_LEGACY_OTLP_PATHS = frozenset(f"{_LEGACY_ROOT}/{signal}" for signal in ("traces", "logs", "metrics"))
# "/api", so that it plus "/v1/chat/completions" is the current route.
_API_PARENT = API_ROOT.removesuffix(_LEGACY_ROOT)


def _is_at_or_under(path: str, root: str) -> bool:
    return path == root or path.startswith(root + "/")


def legacy_prefix(path: str) -> str:
    """Return the prefix that moves a pre-0.6 path onto its current route, or ``""``."""
    if path in _LEGACY_OTLP_PATHS:
        return OTLP_ROOT
    if _is_at_or_under(path, _LEGACY_ROOT):
        return _API_PARENT
    if _is_at_or_under(path, _LEGACY_HEALTH):
        return API_ROOT
    return ""


class LegacyRouteMiddleware:
    """Rewrites a pre-0.6 path in place before routing.

    Must be the outermost middleware, so the security allowlists, metrics labels
    and in-flight registry all see the current path and never the legacy one.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            prefix = legacy_prefix(scope["path"])
            if prefix:
                scope = dict(scope)
                scope["path"] = prefix + scope["path"]
                if "raw_path" in scope:
                    scope["raw_path"] = prefix.encode() + scope["raw_path"]
        await self.app(scope, receive, send)
