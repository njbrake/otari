"""Which query keys a page keeps in a view."""

from urllib.parse import parse_qsl

from gateway.exceptions.saved_views_exceptions import SavedViewQueryInvalidError
from gateway.models.saved_views import VIEW_QUERY_KEYS, SavedViewPage


def require_page_keys(page: SavedViewPage, query: str) -> None:
    """Refuse a query that names a key ``page`` does not keep in a view.

    Raises:
        SavedViewQueryInvalidError: the query names such a key.
    """
    names = {name for name, _ in parse_qsl(query, keep_blank_values=True)}
    unknown = sorted(names - VIEW_QUERY_KEYS[page])
    if unknown:
        raise SavedViewQueryInvalidError(unknown, page.value)
