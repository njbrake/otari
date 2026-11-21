"""Removes a deleted account's private saved views."""

import uuid

from gateway.repositories.saved_views import SavedViewRepository


class SavedViewAccountListener:
    """Removes the private views of an account being deleted, inside the caller's block.

    Its shared views stay, and lose their owner when the account row goes.
    """

    def __init__(self, views: SavedViewRepository) -> None:
        self._views = views

    async def forget_account(self, identity_id: uuid.UUID) -> None:
        """Stage removing every view the account saved and did not share."""
        await self._views.remove_private_owned_by(identity_id)
