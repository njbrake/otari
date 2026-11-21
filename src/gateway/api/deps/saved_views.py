"""Builders for the saved-views domain."""

from typing import Annotated

from fastapi import Depends

from gateway.api.deps._base import UnitOfWorkDep
from gateway.api.deps.organizations import WorkspaceAccessDep
from gateway.repositories.saved_views import SavedViewRepository
from gateway.services.saved_views import SavedViewService


def get_saved_view_service(uow: UnitOfWorkDep, workspaces: WorkspaceAccessDep) -> SavedViewService:
    """Build the saved-views service on the request's Unit of Work."""
    return SavedViewService(uow, SavedViewRepository(uow), workspaces)


SavedViewServiceDep = Annotated[SavedViewService, Depends(get_saved_view_service)]
