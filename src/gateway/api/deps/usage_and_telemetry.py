"""Builders for the usage domain's background work."""

from gateway.core.unit_of_work import UnitOfWork
from gateway.repositories.usage_and_telemetry import UsageLogRepository
from gateway.services.usage_and_telemetry import UsageRollupService


def build_usage_rollup_service(uow: UnitOfWork) -> UsageRollupService:
    """Build the usage rollup refresh for one worker pass."""
    return UsageRollupService(uow, UsageLogRepository(uow))
