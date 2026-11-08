"""The registry of core features.

The one list that says which features this build ships.
It is a literal tuple edited by hand: nothing is discovered and nothing registers itself on import,
so the set of loaded code is fixed at build time.
Each entry names the ``CoreFeature`` its own module declares, so nothing is built here.
Whether a listed feature runs is that feature's own ``enabled`` setting.
"""

from gateway.api.routes.health_checks import FEATURE as HEALTH_CHECKS
from gateway.api.routes.oauth import FEATURE as WORKLOAD_IDENTITY_EXCHANGE
from gateway.api.routes.platform import FEATURE as DEBUG_MEMORY
from gateway.api.routes.traces import FEATURE as TRACES
from gateway.api.routes.traces import RETENTION_FEATURE as TRACE_RETENTION
from gateway.core.feature import CoreFeature

# Upstream ships in-product feedback here, which forwards what a user types to
# api.otari.ai. This fork deletes it: nothing about this deployment's users leaves it.
CORE_FEATURES: tuple[CoreFeature, ...] = (
    HEALTH_CHECKS,
    TRACES,
    TRACE_RETENTION,
    WORKLOAD_IDENTITY_EXCHANGE,
    DEBUG_MEMORY,
)
