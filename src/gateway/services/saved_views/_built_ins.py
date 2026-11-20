"""The views each page offers before anyone saves one. They are not stored, so they cannot be changed or deleted."""

from dataclasses import dataclass

from gateway.models.saved_views import SavedViewPage


@dataclass(frozen=True)
class BuiltInView:
    """A page's own view: a query string under a name, known by its slug."""

    slug: str
    name: str
    query: str


BUILT_IN_VIEWS: dict[SavedViewPage, tuple[BuiltInView, ...]] = {
    SavedViewPage.REQUESTS: (
        BuiltInView("all", "All requests", ""),
        BuiltInView("mine", "My requests", "scope=mine"),
        BuiltInView("failures-this-week", "Failures this week", "range=7d&status=error"),
        BuiltInView("expensive", "Expensive calls", "range=7d&cost_gt=0.4&sort=cost&order=desc"),
        BuiltInView("subscription", "Subscription usage", "channel=imported"),
        BuiltInView("billed-api", "Billed API traffic", "channel=api"),
    ),
    SavedViewPage.SESSIONS: (
        BuiltInView("all", "All sessions", ""),
        BuiltInView("mine", "My sessions", "scope=mine"),
        BuiltInView("with-errors", "Sessions with errors", "range=7d&status=error"),
        BuiltInView("costliest", "Costliest this week", "range=7d&sort=cost&order=desc"),
        BuiltInView("longest", "Longest running", "range=7d&sort=latency&order=desc"),
    ),
}
