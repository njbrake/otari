"""Each page's built-in views are queries its own view keys hold, under names and slugs unique on the page."""

import pytest

from gateway.models.saved_views import SavedViewPage
from gateway.schemas.saved_views import SavedViewCreate
from gateway.services.saved_views._built_ins import BUILT_IN_VIEWS
from gateway.services.saved_views._queries import require_page_keys


@pytest.mark.parametrize("page", list(SavedViewPage))
def test_every_page_offers_valid_built_in_views(page: SavedViewPage) -> None:
    views = BUILT_IN_VIEWS[page]
    assert views[0].query == ""
    assert len({view.slug for view in views}) == len(views)
    assert len({view.name.lower() for view in views}) == len(views)
    for view in views:
        SavedViewCreate(page=page, name=view.name, query=view.query)
        require_page_keys(page, view.query)
