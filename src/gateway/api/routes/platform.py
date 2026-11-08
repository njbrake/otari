"""Opt-in diagnostics about this process, mounted only when ``debug_memory`` is on.

Listed in ``CORE_FEATURES`` as ``FEATURE`` below, and out of the OpenAPI spec:
it is an operator's temporary instrument rather than part of the API.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from gateway.api.deps import require_deployment_operator
from gateway.core.feature import CoreFeature
from gateway.schemas.platform import MemoryDiagnostics
from gateway.services.platform import MemoryDiagnosticsService

router = APIRouter(
    prefix="/debug",
    tags=["debug"],
    include_in_schema=False,
    dependencies=[Depends(require_deployment_operator)],
)

# One per process, like the heap it measures and the baseline it keeps.
_diagnostics = MemoryDiagnosticsService()


@router.get("/memory")
async def read_memory(
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    reset_baseline: bool = False,
    trim: bool = False,
) -> MemoryDiagnostics:
    """Report this process's memory, optionally trimming the glibc heap afterward."""
    return await _diagnostics.read(limit=limit, reset_baseline=reset_baseline, trim=trim)


FEATURE = CoreFeature(
    name="debug_memory",
    surface=None,
    enabled=lambda config: config.debug_memory,
    routers=lambda config: (router,),
)
