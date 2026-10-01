"""Saved views: who may see, share, change and delete a workspace's views."""

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
import pytest_asyncio
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from gateway.core.config import API_ROOT
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import WorkspaceNotFoundError
from gateway.exceptions.saved_views_exceptions import (
    SavedViewLimitReachedError,
    SavedViewNameTakenError,
    SavedViewNotFoundError,
    SavedViewNotYoursError,
    SavedViewSharingForbiddenError,
)
from gateway.models.saved_views import MAX_VIEWS_PER_PAGE
from gateway.models.tenancy import User, Workspace, WorkspaceMember
from gateway.repositories.saved_views import SavedViewRepository
from gateway.repositories.tenancy import WorkspaceMemberRepository
from gateway.schemas.saved_views import SavedViewCreate, SavedViewUpdate
from gateway.services.budgets import WorkspaceBudgetDefaultService
from gateway.services.saved_views import SavedViewService
from gateway.services.tenancy import WorkspaceService

from .tenancy_helpers import create_member, create_organization, create_workspace


class _Team:
    """One organization, two workspaces, and the people in and around them."""

    def __init__(self, workspace: Workspace, other: Workspace, people: dict[str, User]) -> None:
        self.workspace = workspace
        self.other = other
        self.people = people


async def _team(db: AsyncSession, *, slug: str) -> _Team:
    organization = await create_organization(db, slug=slug)
    manager = await create_member(db, organization, role="member", full_name="Manager")
    member = await create_member(db, organization, role="member", full_name="Member")
    colleague = await create_member(db, organization, role="member", full_name="Colleague")
    # An organization admin who belongs to no workspace, and a member who belongs to none.
    org_admin = await create_member(db, organization, role="admin", full_name="Org admin")
    bystander = await create_member(db, organization, role="member", full_name="Bystander")
    workspace = await create_workspace(db, organization, name="Team", owner=manager)
    other = await create_workspace(db, organization, name="Other team", owner=manager)
    memberships = WorkspaceMemberRepository(db)
    for person in (member, colleague):
        await memberships.create(workspace_id=workspace.id, user_id=person.id, role="member")
    await memberships.create(workspace_id=other.id, user_id=member.id, role="member")
    await db.commit()
    # A refused step rolls the session back and expires what is attached, so the tests hold detached rows.
    db.expunge_all()
    people = {
        "manager": manager,
        "member": member,
        "colleague": colleague,
        "org_admin": org_admin,
        "bystander": bystander,
    }
    return _Team(workspace, other, people)


def _service(db: AsyncSession) -> SavedViewService:
    uow = UnitOfWork(db)
    return SavedViewService(
        uow, SavedViewRepository(uow), WorkspaceService(db, membership_listener=WorkspaceBudgetDefaultService(db))
    )


def _view(name: str = "Failures this week", **overrides: Any) -> SavedViewCreate:
    fields: dict[str, Any] = {"page": "activity", "name": name, "query": "window=7d&status=error"}
    fields.update(overrides)
    return SavedViewCreate(**fields)


async def _menu(db: AsyncSession, team: _Team, who: str) -> list[tuple[str, bool]]:
    listed = await _service(db).list_views(user=team.people[who], workspace_id=team.workspace.id, page="activity")
    return [(view.name, view.is_mine) for view in listed.data]


@pytest.mark.asyncio
async def test_a_private_view_is_listed_only_for_its_owner(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-private")

    created = await _service(async_db).create_view(
        user=team.people["member"], workspace_id=team.workspace.id, request=_view()
    )

    assert created.is_mine
    assert created.owner_name == "Member"
    assert await _menu(async_db, team, "member") == [("Failures this week", True)]
    assert await _menu(async_db, team, "colleague") == []


@pytest.mark.asyncio
async def test_a_shared_view_is_offered_to_the_workspace_after_the_callers_own(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-shared")
    service = _service(async_db)
    await service.create_view(
        user=team.people["manager"], workspace_id=team.workspace.id, request=_view("A", shared=True)
    )
    await service.create_view(user=team.people["colleague"], workspace_id=team.workspace.id, request=_view("Z"))

    listed = await service.list_views(user=team.people["colleague"], workspace_id=team.workspace.id, page="activity")

    # Their own first, so a long list of shared views can never push theirs out.
    assert [(v.name, v.shared, v.is_mine, v.owner_name) for v in listed.data] == [
        ("Z", False, True, "Colleague"),
        ("A", True, False, "Manager"),
    ]


@pytest.mark.asyncio
async def test_a_name_is_trimmed_and_one_view_per_person(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-names")
    service = _service(async_db)
    await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("Slow"))

    with pytest.raises(SavedViewNameTakenError):
        await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("Slow "))
    # The menu sorts names ignoring case, so they are unique ignoring case.
    with pytest.raises(SavedViewNameTakenError):
        await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("slow"))
    # Two people may each keep a view of the same name.
    await service.create_view(user=team.people["colleague"], workspace_id=team.workspace.id, request=_view("Slow"))
    with pytest.raises(ValueError, match="at least 1 character"):
        _view("   ")


@pytest.mark.asyncio
async def test_a_rename_onto_another_of_ones_own_names_is_refused(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-rename")
    service = _service(async_db)
    await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("One"))
    two = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("Two"))

    with pytest.raises(SavedViewNameTakenError):
        await service.update_view(
            user=team.people["member"],
            workspace_id=team.workspace.id,
            view_id=two.id,
            request=SavedViewUpdate(name="One"),
        )


@pytest.mark.asyncio
async def test_an_update_changes_only_what_it_names(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-update")
    service = _service(async_db)
    view = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("One"))

    changed = await service.update_view(
        user=team.people["member"],
        workspace_id=team.workspace.id,
        view_id=view.id,
        request=SavedViewUpdate(query="window=24h"),
    )
    assert (changed.name, changed.query) == ("One", "window=24h")
    assert changed.updated_at is not None
    # An explicit null leaves the field as it is, as the schema says.
    unchanged = await service.update_view(
        user=team.people["member"],
        workspace_id=team.workspace.id,
        view_id=view.id,
        request=SavedViewUpdate.model_validate({"name": None, "query": None}),
    )
    assert (unchanged.name, unchanged.query) == ("One", "window=24h")


@pytest.mark.asyncio
async def test_only_someone_who_manages_the_workspace_shares(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-share-gate")
    service = _service(async_db)

    with pytest.raises(SavedViewSharingForbiddenError):
        await service.create_view(
            user=team.people["member"], workspace_id=team.workspace.id, request=_view(shared=True)
        )
    mine = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view())
    with pytest.raises(SavedViewSharingForbiddenError):
        await service.update_view(
            user=team.people["member"],
            workspace_id=team.workspace.id,
            view_id=mine.id,
            request=SavedViewUpdate(shared=True),
        )
    # An organization admin manages every workspace in it, member or not.
    await service.create_view(user=team.people["org_admin"], workspace_id=team.workspace.id, request=_view(shared=True))


@pytest.mark.asyncio
async def test_an_owner_who_no_longer_manages_may_unshare_but_not_edit(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-demoted")
    service = _service(async_db)
    shared = await service.create_view(
        user=team.people["manager"], workspace_id=team.workspace.id, request=_view(shared=True)
    )
    membership = await WorkspaceMemberRepository(async_db).get_active_by_workspace_and_user(
        team.workspace.id, team.people["manager"].id
    )
    assert isinstance(membership, WorkspaceMember)
    membership.role = "member"
    await async_db.commit()
    async_db.expunge_all()

    with pytest.raises(SavedViewSharingForbiddenError):
        await service.update_view(
            user=team.people["manager"],
            workspace_id=team.workspace.id,
            view_id=shared.id,
            request=SavedViewUpdate(query="window=1h"),
        )
    unshared = await service.update_view(
        user=team.people["manager"],
        workspace_id=team.workspace.id,
        view_id=shared.id,
        request=SavedViewUpdate(shared=False),
    )
    assert unshared.shared is False


@pytest.mark.asyncio
async def test_only_the_owner_changes_a_view(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-owner")
    service = _service(async_db)
    shared = await service.create_view(
        user=team.people["manager"], workspace_id=team.workspace.id, request=_view(shared=True)
    )
    private = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view())

    # Someone else's shared view is visible, so changing it is refused rather than hidden.
    with pytest.raises(SavedViewNotYoursError):
        await service.update_view(
            user=team.people["colleague"],
            workspace_id=team.workspace.id,
            view_id=shared.id,
            request=SavedViewUpdate(name="Mine now"),
        )
    # Someone else's private view does not exist, as far as the caller can tell.
    with pytest.raises(SavedViewNotFoundError):
        await service.update_view(
            user=team.people["colleague"],
            workspace_id=team.workspace.id,
            view_id=private.id,
            request=SavedViewUpdate(name="Mine now"),
        )


@pytest.mark.asyncio
async def test_who_may_delete_a_view(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-delete")
    service = _service(async_db)
    managers = await service.create_view(
        user=team.people["manager"], workspace_id=team.workspace.id, request=_view("Theirs", shared=True)
    )
    private = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view())

    with pytest.raises(SavedViewNotYoursError):
        await service.delete_view(user=team.people["colleague"], workspace_id=team.workspace.id, view_id=managers.id)
    # Managing the workspace reaches shared views, never someone's private one.
    with pytest.raises(SavedViewNotFoundError):
        await service.delete_view(user=team.people["manager"], workspace_id=team.workspace.id, view_id=private.id)
    await service.delete_view(user=team.people["member"], workspace_id=team.workspace.id, view_id=private.id)
    await service.delete_view(user=team.people["manager"], workspace_id=team.workspace.id, view_id=managers.id)
    assert await _menu(async_db, team, "member") == []


@pytest.mark.asyncio
async def test_a_view_is_found_only_in_its_own_workspace(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-cross")
    service = _service(async_db)
    view = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view())

    # The member can see both workspaces; the view belongs to one.
    with pytest.raises(SavedViewNotFoundError):
        await service.update_view(
            user=team.people["member"],
            workspace_id=team.other.id,
            view_id=view.id,
            request=SavedViewUpdate(name="X"),
        )
    with pytest.raises(SavedViewNotFoundError):
        await service.delete_view(user=team.people["member"], workspace_id=team.other.id, view_id=view.id)


@pytest.mark.asyncio
async def test_someone_outside_the_workspace_is_told_it_does_not_exist(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-outside")
    service = _service(async_db)
    view = await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view())
    elsewhere = await create_organization(async_db, slug="views-elsewhere")
    stranger = await create_member(async_db, elsewhere, role="owner", full_name="Stranger")
    await async_db.commit()
    async_db.expunge_all()

    for outsider in (team.people["bystander"], stranger):
        with pytest.raises(WorkspaceNotFoundError):
            await service.list_views(user=outsider, workspace_id=team.workspace.id, page="activity")
        with pytest.raises(WorkspaceNotFoundError):
            await service.create_view(user=outsider, workspace_id=team.workspace.id, request=_view())
        with pytest.raises(WorkspaceNotFoundError):
            await service.update_view(
                user=outsider, workspace_id=team.workspace.id, view_id=view.id, request=SavedViewUpdate(name="X")
            )
        with pytest.raises(WorkspaceNotFoundError):
            await service.delete_view(user=outsider, workspace_id=team.workspace.id, view_id=view.id)


@pytest.mark.asyncio
async def test_a_person_keeps_a_bounded_number_of_views_per_page(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-limit")
    service = _service(async_db)
    for index in range(MAX_VIEWS_PER_PAGE):
        await service.create_view(
            user=team.people["member"], workspace_id=team.workspace.id, request=_view(f"View {index}")
        )

    with pytest.raises(SavedViewLimitReachedError):
        await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view("One more"))


@pytest_asyncio.fixture
async def sessions(postgres_url: str) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    url = postgres_url.replace("postgresql+psycopg2://", "postgresql+asyncpg://").replace(
        "postgresql://", "postgresql+asyncpg://"
    )
    engine = create_async_engine(url)
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest.mark.asyncio
async def test_concurrent_saves_cannot_pass_the_limit(
    async_db: AsyncSession, sessions: async_sessionmaker[AsyncSession]
) -> None:
    """Each save counts the owner's views and then writes, so the count is serialized per owner and page."""
    team = await _team(async_db, slug="views-race")
    member = team.people["member"]
    service = _service(async_db)
    for index in range(MAX_VIEWS_PER_PAGE - 1):
        await service.create_view(user=member, workspace_id=team.workspace.id, request=_view(f"View {index}"))
    racers = 4

    async def save(index: int) -> object:
        async with sessions() as session:
            try:
                return await _service(session).create_view(
                    user=member, workspace_id=team.workspace.id, request=_view(f"Racer {index}")
                )
            except SavedViewLimitReachedError as exc:
                return exc

    outcomes = await asyncio.gather(*(save(index) for index in range(racers)))

    refused = [outcome for outcome in outcomes if isinstance(outcome, SavedViewLimitReachedError)]
    assert len(refused) == racers - 1, outcomes
    listed = await _service(async_db).list_views(user=member, workspace_id=team.workspace.id, page="activity")
    assert listed.count == MAX_VIEWS_PER_PAGE


@pytest.mark.asyncio
async def test_the_menu_pages_with_the_callers_own_views_first(async_db: AsyncSession) -> None:
    team = await _team(async_db, slug="views-paging")
    service = _service(async_db)
    for name in ("Beta", "Alpha"):
        await service.create_view(user=team.people["member"], workspace_id=team.workspace.id, request=_view(name))
    await service.create_view(
        user=team.people["manager"], workspace_id=team.workspace.id, request=_view("Aardvark", shared=True)
    )

    first = await service.list_views(
        user=team.people["member"], workspace_id=team.workspace.id, page="activity", skip=0, limit=2
    )
    rest = await service.list_views(
        user=team.people["member"], workspace_id=team.workspace.id, page="activity", skip=2, limit=2
    )

    assert [view.name for view in first.data] == ["Alpha", "Beta"]
    assert [view.name for view in rest.data] == ["Aardvark"]
    assert first.count == rest.count == 3


def test_the_routes_save_list_change_and_delete_a_view(client: TestClient, master_key_header: dict[str, str]) -> None:
    workspace_id = client.get(f"{API_ROOT}/workspaces", headers=master_key_header).json()["data"][0]["id"]
    views = f"{API_ROOT}/workspaces/{workspace_id}/saved-views"

    created = client.post(
        views, json={"page": "activity", "name": "Slow", "query": "latency_ms_gt=5000"}, headers=master_key_header
    )
    assert created.status_code == status.HTTP_201_CREATED, created.text
    view_id = created.json()["id"]
    listed = client.get(views, params={"page": "activity"}, headers=master_key_header).json()
    assert [view["name"] for view in listed["data"]] == ["Slow"]
    assert listed["count"] == 1

    patched = client.patch(f"{views}/{view_id}", json={"shared": True}, headers=master_key_header)
    assert patched.status_code == status.HTTP_200_OK, patched.text
    assert patched.json()["shared"] is True

    assert client.delete(f"{views}/{view_id}", headers=master_key_header).status_code == status.HTTP_200_OK
    assert client.get(views, params={"page": "activity"}, headers=master_key_header).json()["data"] == []
    unknown_page = client.get(views, params={"page": "nowhere"}, headers=master_key_header)
    assert unknown_page.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    too_many = client.get(views, params={"page": "activity", "limit": 1001}, headers=master_key_header)
    assert too_many.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


@pytest.mark.parametrize(
    "query",
    ["/elsewhere", "//evil.example", "https://evil.example", "?range=24h", "range=24h#top", "q=a b", " range=1h"],
)
def test_a_view_holds_only_a_query_string(client: TestClient, master_key_header: dict[str, str], query: str) -> None:
    workspace_id = client.get(f"{API_ROOT}/workspaces", headers=master_key_header).json()["data"][0]["id"]
    refused = client.post(
        f"{API_ROOT}/workspaces/{workspace_id}/saved-views",
        json={"page": "activity", "name": "Somewhere", "query": query},
        headers=master_key_header,
    )
    assert refused.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT


def test_the_default_view_saves_as_an_empty_query(client: TestClient, master_key_header: dict[str, str]) -> None:
    workspace_id = client.get(f"{API_ROOT}/workspaces", headers=master_key_header).json()["data"][0]["id"]
    saved = client.post(
        f"{API_ROOT}/workspaces/{workspace_id}/saved-views",
        json={"page": "activity", "name": "Everything", "query": ""},
        headers=master_key_header,
    )
    assert saved.status_code == status.HTTP_201_CREATED, saved.text
