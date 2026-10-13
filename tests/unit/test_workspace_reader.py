"""The reader the workspace visibility settings make of a caller."""

import pytest

from gateway.exceptions.organizations_exceptions import WorkspaceTotalsHiddenError, WorkspaceTotalsNarrowingError
from gateway.services.organizations import WorkspaceReader


def _reader(*, sees_everyone: bool, totals_shared: bool) -> WorkspaceReader:
    return WorkspaceReader(
        sees_everyone=sees_everyone,
        totals_shared=totals_shared,
        totals_dimensions=("model",),
        totals_filters=frozenset({"model"}),
    )


def test_a_reader_who_sees_everyone_may_split_and_narrow_the_totals_by_anything() -> None:
    _reader(sees_everyone=True, totals_shared=False).require_totals(breakdowns=["user"], filters=["user_id"])


def test_a_member_is_refused_totals_the_workspace_keeps_from_them() -> None:
    with pytest.raises(WorkspaceTotalsHiddenError):
        _reader(sees_everyone=False, totals_shared=False).require_totals(breakdowns=["model"], filters=[])


@pytest.mark.parametrize(("breakdowns", "filters"), [(["user"], []), (["model"], ["user_id"])])
def test_a_member_is_refused_a_split_or_filter_outside_the_allowlist(breakdowns: list[str], filters: list[str]) -> None:
    with pytest.raises(WorkspaceTotalsNarrowingError):
        _reader(sees_everyone=False, totals_shared=True).require_totals(breakdowns=breakdowns, filters=filters)
