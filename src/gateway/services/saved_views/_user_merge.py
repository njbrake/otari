"""Moving a merged user's saved views onto the user it was merged into."""

import uuid
from collections.abc import Collection, Mapping

from gateway.exceptions.organizations_exceptions import UserMergeRefusedError
from gateway.repositories.saved_views import SavedViewRepository


def _identity_id(user_id: str) -> uuid.UUID | None:
    """The sign-in identity a billing user's id names, which is what owns a view, or None."""
    try:
        return uuid.UUID(user_id)
    except ValueError:
        return None


class SavedViewUserMergeListener:
    """Moves a merged user's views inside the caller's Unit of Work block.

    A view belongs to a sign-in identity, and a merge refuses a source that is a
    sign-in account's own user, so a merge finds none to move today. Should one
    reach it, the views follow the target identity, and a name both hold on one
    page of one workspace refuses the merge, as a same-named alias does.
    """

    def __init__(self, views: SavedViewRepository) -> None:
        self._views = views

    async def rows_elsewhere(self, user_id: str, workspace_ids: Collection[uuid.UUID]) -> list[str]:
        """The tables holding a row of ``user_id`` in a workspace other than these."""
        identity = _identity_id(user_id)
        return ["saved_views"] if identity and await self._views.owned_outside(identity, workspace_ids) else []

    async def user_merged(
        self, from_user_id: str, to_user_id: str, *, preview: bool, resumed: bool
    ) -> Mapping[str, int]:
        """Point every view of ``from_user_id`` at ``to_user_id``, or with ``preview`` count them."""
        source = _identity_id(from_user_id)
        count = await self._views.count_owned_by(source) if source else 0
        if source is None or count == 0:
            return {"saved_views": 0}
        target = _identity_id(to_user_id)
        if target is None:
            raise UserMergeRefusedError(f"User '{from_user_id}' has saved views, which only a sign-in account can own")
        clashing = await self._views.names_owned_by_both(source, target)
        if clashing:
            raise UserMergeRefusedError(f"Both users saved a view named {', '.join(repr(name) for name in clashing)}")
        if preview:
            return {"saved_views": count}
        return {"saved_views": await self._views.reassign_owner(source, target)}

    async def merge_committed(self) -> None:
        """Nothing to do once the merge commits."""
