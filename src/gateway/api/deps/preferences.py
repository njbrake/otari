"""Builders for the preferences domain."""

from typing import Annotated

from fastapi import Depends

from gateway.api.deps._base import UnitOfWorkDep
from gateway.repositories.preferences import UserPreferenceRepository
from gateway.services.preferences import PreferenceService


def get_preference_service(uow: UnitOfWorkDep) -> PreferenceService:
    """Build the caller's preferences on the request's Unit of Work."""
    return PreferenceService(uow, UserPreferenceRepository(uow))


PreferenceServiceDep = Annotated[PreferenceService, Depends(get_preference_service)]
