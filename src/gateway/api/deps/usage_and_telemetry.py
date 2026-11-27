"""Builders for the usage domain's services and background work."""

from typing import Annotated

from fastapi import Depends

from gateway.api.deps._base import HeavyUsageReadsDep, get_unit_of_work
from gateway.api.deps.api_keys import get_api_key_service
from gateway.api.deps.organizations import get_user_access
from gateway.core.unit_of_work import UnitOfWork
from gateway.ports.telemetry_storage_port import TelemetryStoragePort
from gateway.repositories.usage_and_telemetry import UsageLogRepository
from gateway.services.usage_and_telemetry import TelemetryRetentionService, UsageRollupService, UsageService


def get_usage_service(
    uow: Annotated[UnitOfWork, Depends(get_unit_of_work)], heavy_reads: HeavyUsageReadsDep
) -> UsageService:
    """Build the usage service on the request's Unit of Work; its labels come from the key and user domains."""
    return UsageService(
        uow,
        UsageLogRepository(uow),
        keys=get_api_key_service(uow),
        users=get_user_access(uow),
        heavy_reads=heavy_reads,
    )


UsageServiceDep = Annotated[UsageService, Depends(get_usage_service)]


def build_usage_rollup_service(uow: UnitOfWork) -> UsageRollupService:
    """Build the usage rollup refresh for one worker pass."""
    return UsageRollupService(uow, UsageLogRepository(uow))


def build_telemetry_retention_service(uow: UnitOfWork, storage: TelemetryStoragePort) -> TelemetryRetentionService:
    """Build the telemetry retention sweep for one worker pass."""
    return TelemetryRetentionService(uow, UsageLogRepository(uow), storage)
