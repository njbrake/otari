"""Telemetry ingest draws from a pool of its own, and only telemetry ingest does.

An import is a write of history somebody else already has: the exporter that sent
it will send it again, and two exporters resending the same batch contend on the
idempotency key. A batch that waits behind another transaction holds its pooled
connection while it waits, so on the request pool a burst of imports is an outage
for everything that needs a connection to answer, sign-in first among them.
"""

from fastapi.routing import APIRoute

from gateway.api.routes.otlp import router as otlp_router
from gateway.api.routes.usage import ingest_router, operator_router
from gateway.core.config import GatewayConfig
from gateway.core.database import get_db, get_ingest_db, init_db, reset_db


def _own_dependencies(route: APIRoute) -> set[object]:
    """The dependencies the handler itself declares, not what they pull in.

    Authentication resolves an API key on the request pool whichever door it
    guards, so only the session the handler writes with is the question here.
    """
    return {dependency.call for dependency in route.dependant.dependencies}


def _routes(router: object) -> list[APIRoute]:
    return [route for route in router.routes if isinstance(route, APIRoute)]  # type: ignore[attr-defined]


def test_every_ingest_route_writes_on_the_ingest_pool() -> None:
    ingest = _routes(otlp_router) + _routes(ingest_router)
    assert ingest, "expected the OTLP and external-events routes to be mounted"

    for route in ingest:
        assert get_ingest_db in _own_dependencies(route), route.path
        assert get_db not in _own_dependencies(route), route.path


def test_the_rest_of_the_usage_api_stays_on_the_request_pool() -> None:
    # The ingest pool is a ceiling, so a read that wandered onto it would be
    # capped by it and would take a slot an import is waiting for.
    for route in _routes(operator_router):
        assert get_ingest_db not in _own_dependencies(route), route.path


def test_the_pools_are_separate_engines() -> None:
    config = GatewayConfig(
        database_url="postgresql://user:pw@localhost:5432/otari",
        auto_migrate=False,
        db_ingest_pool_size=3,
    )
    try:
        init_db(config)
        from gateway.core import database

        assert database._ingest_engine is not None
        assert database._ingest_engine is not database._engine
        assert database._ingest_engine is not database._log_engine
        assert database._ingest_engine.pool.status().startswith("Pool size: 3")
    finally:
        reset_db()
