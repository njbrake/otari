"""Usage-row filter conditions that the read endpoints and the bulk mutations share.

The same reason ``core/sql.py`` exists, one step more specific: these conditions
name ORM columns, so they cannot live in that dialect-level module, and they must be
built once, because a bulk delete re-derives its target set from the filters an
operator was shown. A search the list honored and the delete read differently would
delete rows no count ever promised.
"""

import uuid

from sqlalchemy import ColumnElement, or_, select

from gateway.models.api_keys import APIKey
from gateway.models.usage import UsageLog
from gateway.models.users import User

# Longest search a caller may send. Far past a request id or a model name; it keeps a
# caller from posting a megabyte pattern into a LIKE over the window searched.
MAX_SEARCH_LENGTH = 200


def is_substring_search(q: str | None) -> bool:
    """Whether ``q`` searches by substring, which no index serves, rather than looking up an id.

    The split :func:`usage_search_condition` makes: a UUID is an exact lookup on
    two indexed columns, anything else a ``LIKE`` over several.
    """
    term = (q or "").strip()
    if not term:
        return False
    try:
        uuid.UUID(term)
    except ValueError:
        return True
    return False


def usage_search_condition(q: str) -> ColumnElement[bool] | None:
    """Rows a free-text search matches, or None when there is nothing to search for.

    A UUID is an ``Otari-Request-ID`` or a row id pasted from a log line, so it is
    matched, in canonical form, against those two columns alone, which keeps the
    lookup on their indexes (an OR with the substring arms below could use none). A
    session label, key name or alias that is itself a UUID is not searched this way;
    none is written in that form. Everything else is a
    case-insensitive substring of the served model, the name the caller sent (so an
    alias finds its rows), the session label, the API key's name or the billed user's
    alias. The two names live on other tables and are matched through
    ``IN (subquery)`` so the condition fits any statement over ``usage_logs`` (a
    count, a summary, a delete) without it carrying the joins. ``autoescape`` makes
    ``%`` and ``_`` literal.
    """
    term = q.strip()
    if not term:
        return None
    try:
        canonical = str(uuid.UUID(term))
    except ValueError:
        pass
    else:
        return or_(UsageLog.request_id == canonical, UsageLog.id == canonical)
    return or_(
        UsageLog.model.icontains(term, autoescape=True),
        UsageLog.requested_model.icontains(term, autoescape=True),
        UsageLog.source_label.icontains(term, autoescape=True),
        UsageLog.api_key_id.in_(select(APIKey.id).where(APIKey.key_name.icontains(term, autoescape=True))),
        UsageLog.user_id.in_(select(User.user_id).where(User.alias.icontains(term, autoescape=True))),
    )
