"""Errors that the saved-views domain may raise."""

from fastapi import status

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
    """The view's owner already has a view of this name on this page, ignoring case.

    ``former_owner`` says so of a manager renaming a view whose owner left, since the name is the owner's.
    """

    def __init__(self, name: str, *, former_owner: bool = False):
        whose = "This view's former owner already has" if former_owner else "You already have"
        super().__init__(f"{whose} a view named '{name}' on this page")


class SavedViewNotYoursError(TenancyForbiddenError):
    """The view is visible, because it is shared, but belongs to someone else."""

    def __init__(self) -> None:
        super().__init__("Only the person who saved this view may change it")


class SavedViewSharingForbiddenError(TenancyForbiddenError):
    def __init__(self) -> None:
        super().__init__("Only someone who manages this workspace may share a view with it, or change a shared one")


class SavedViewOwnerLeftError(TenancyConflictError):
    """A shared view whose owner is gone cannot be made private: nobody would be left to open it."""

    def __init__(self) -> None:
        super().__init__("This view's owner is no longer in the workspace, so delete it rather than stop sharing it")


class SavedViewLimitReachedError(TenancyValidationError):
    def __init__(self, limit: int):
        super().__init__(f"You can keep up to {limit} saved views on a page; delete one to save another")


class SavedViewQueryInvalidError(TenancyValidationError):
    """The query names a key the page does not read as part of a view."""

    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT

    def __init__(self, keys: list[str], page: str):
        super().__init__(f"The {page} page does not keep {', '.join(keys)} in a view")


__all__ = [
    "SavedViewLimitReachedError",
    "SavedViewNameTakenError",
    "SavedViewNotFoundError",
    "SavedViewNotYoursError",
    "SavedViewOwnerLeftError",
    "SavedViewQueryInvalidError",
    "SavedViewSharingForbiddenError",
]
