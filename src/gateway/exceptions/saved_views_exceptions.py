"""Errors that the saved-views domain may raise."""

from gateway.exceptions import (
    TenancyConflictError,
    TenancyForbiddenError,
    TenancyNotFoundError,
    TenancyValidationError,
)


class SavedViewNotFoundError(TenancyNotFoundError):
    """No view under this id is visible to the caller in this workspace.

    One answer for a view that does not exist, one in another workspace, and
    someone else's private one, so the id is never an existence oracle.
    """

    def __init__(self, view_id: object):
        super().__init__(f"Saved view {view_id} not found")


class SavedViewNameTakenError(TenancyConflictError):
    def __init__(self, name: str):
        super().__init__(f"You already have a view named '{name}' on this page")


class SavedViewNotYoursError(TenancyForbiddenError):
    """The view is visible (it is shared) but belongs to someone else."""

    def __init__(self) -> None:
        super().__init__("Only the person who saved this view may change it")


class SavedViewSharingForbiddenError(TenancyForbiddenError):
    def __init__(self) -> None:
        super().__init__(
            "Only someone who manages this workspace may share a view with it, or change one shared with it"
        )


class SavedViewLimitReachedError(TenancyValidationError):
    def __init__(self, limit: int):
        super().__init__(f"You can keep up to {limit} saved views on a page; delete one to save another")


__all__ = [
    "SavedViewLimitReachedError",
    "SavedViewNameTakenError",
    "SavedViewNotFoundError",
    "SavedViewNotYoursError",
    "SavedViewSharingForbiddenError",
]
