"""Saved views: a page's filters kept under a name, per person or shared with a workspace.

The rules that turn on roles (a member refused sharing, another member's view
not found, a foreign workspace not found) are exercised at the service layer
with identities built at whatever role a case needs; the HTTP surface is the
operator's round trip and the request validation.
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from gateway.api.deps import get_membership_listener
from gateway.core.config import API_ROOT
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import UserMergeRefusedError, WorkspaceNotFoundError
from gateway.exceptions.saved_views_exceptions import (
    SavedViewLimitReachedError,
    SavedViewNameTakenError,
    SavedViewNotFoundError,
    SavedViewNotYoursError,
    SavedViewOwnerLeftError,
    SavedViewQueryInvalidError,
    SavedViewSharingForbiddenError,
)
from gateway.models.saved_views import MAX_VIEWS_PER_PAGE, SavedView, SavedViewPage
from gateway.models.tenancy import ActiveOrganizationMemberUpdateRequest, Organization, User, Workspace
from gateway.repositories.saved_views import SavedViewRepository
from gateway.repositories.tenancy import WorkspaceMemberRepository
from gateway.schemas.saved_views import SavedViewCreate, SavedViewUpdate
from gateway.services.saved_views import SavedViewAccountListener, SavedViewService, SavedViewUserMergeListener
from gateway.services.tenancy.authorization import WorkspaceAccess
from gateway.services.tenancy.organization_service import OrganizationService
from gateway.services.tenancy.workspace_service import WorkspaceService

from .tenancy_helpers import NO_SSO_ENFORCEMENT, create_member, create_organization, create_workspace

REQUESTS = SavedViewPage.REQUESTS
SESSIONS = SavedViewPage.SESSIONS


def _service(db: AsyncSession) -> SavedViewService:
    uow = UnitOfWork(db)
    return SavedViewService(
        uow, SavedViewRepository(uow), WorkspaceAccess(db, OrganizationService(db, membership_listener=None))
    )


async def _world(db: AsyncSession, slug: str) -> tuple[Organization, Workspace, User, User]:
    """An organization with a workspace its owner manages and a plain member belongs to."""
    organization = await create_organization(db, slug=slug)
    manager = await create_member(db, organization, role="owner", full_name="Mona Manager")
    workspace = await create_workspace(db, organization, name="Engineering", owner=manager)
    member = await create_member(db, organization, role="member", full_name="Max Member")
    await WorkspaceMemberRepository(db).create(workspace_id=workspace.id, user_id=member.id, role="member")
    await db.commit()
    return organization, workspace, manager, member


async def _reload(db: AsyncSession) -> None:
    """Load again what a refused block's rollback expired, so the test can keep using it."""
    for row in list(db.identity_map.values()):
        await db.refresh(row)


def _create(
    name: str, query: str = "status=error", *, page: SavedViewPage = REQUESTS, shared: bool = False
) -> SavedViewCreate:
    return SavedViewCreate(page=page, name=name, query=query, shared=shared)


@pytest.mark.asyncio
async def test_the_list_offers_built_in_views_first_then_your_own(async_db: AsyncSession) -> None:
    _, workspace, _, member = await _world(async_db, "views-list")
    service = _service(async_db)
    await service.create_view(user=member, workspace_id=workspace.id, request=_create("Mine"))

    listed = await service.list_views(user=member, workspace_id=workspace.id, page=REQUESTS)

    built_in = [view for view in listed.data if view.built_in]
    assert [view.name for view in built_in][:1] == ["All requests"]
    assert all(view.id.startswith("built-in:") and not view.can_edit and not view.can_delete for view in built_in)
    own = listed.data[len(built_in) :]
    assert [(view.name, view.is_mine, view.can_edit, view.can_delete) for view in own] == [("Mine", True, True, True)]
    assert listed.can_share is False


@pytest.mark.asyncio
async def test_a_private_view_is_not_visible_to_another_member(async_db: AsyncSession) -> None:
    _, workspace, manager, member = await _world(async_db, "views-private")
    service = _service(async_db)
    view = await service.create_view(user=member, workspace_id=workspace.id, request=_create("Mine"))

    listed = await service.list_views(user=manager, workspace_id=workspace.id, page=REQUESTS)
    assert all(row.built_in for row in listed.data)
    view_id = uuid.UUID(view.id)
    with pytest.raises(SavedViewNotFoundError):
        await service.update_view(
            user=manager, workspace_id=workspace.id, view_id=view_id, request=SavedViewUpdate(name="Taken")
        )
    await _reload(async_db)
    with pytest.raises(SavedViewNotFoundError):
        await service.delete_view(user=manager, workspace_id=workspace.id, view_id=view_id)
    await _reload(async_db)


@pytest.mark.asyncio
async def test_only_a_manager_shares_and_a_shared_view_reads_as_theirs(async_db: AsyncSession) -> None:
    _, workspace, manager, member = await _world(async_db, "views-share")
    service = _service(async_db)
    with pytest.raises(SavedViewSharingForbiddenError):
        await service.create_view(user=member, workspace_id=workspace.id, request=_create("Team", shared=True))
    await _reload(async_db)
    own = await service.create_view(user=member, workspace_id=workspace.id, request=_create("Mine"))
    with pytest.raises(SavedViewSharingForbiddenError):
        await service.update_view(
            user=member, workspace_id=workspace.id, view_id=uuid.UUID(own.id), request=SavedViewUpdate(shared=True)
        )
    await _reload(async_db)

    shared = await service.create_view(user=manager, workspace_id=workspace.id, request=_create("Team", shared=True))

    listed = await service.list_views(user=member, workspace_id=workspace.id, page=REQUESTS)
    team = next(view for view in listed.data if view.name == "Team")
    assert (team.shared, team.is_mine, team.owner_name, team.can_edit, team.can_delete) == (
        True,
        False,
        "Mona Manager",
        False,
        False,
    )
    with pytest.raises(SavedViewNotYoursError):
        await service.update_view(
            user=member, workspace_id=workspace.id, view_id=uuid.UUID(shared.id), request=SavedViewUpdate(name="Ours")
        )
    await _reload(async_db)
    with pytest.raises(SavedViewNotYoursError):
        await service.delete_view(user=member, workspace_id=workspace.id, view_id=uuid.UUID(shared.id))
    await _reload(async_db)


@pytest.mark.asyncio
async def test_a_manager_who_loses_the_role_may_only_stop_sharing_their_view(async_db: AsyncSession) -> None:
    organization, workspace, _, member = await _world(async_db, "views-demoted")
    admin = await create_member(async_db, organization, role="member", full_name="Wes Admin")
    membership = await WorkspaceMemberRepository(async_db).create(
        workspace_id=workspace.id, user_id=admin.id, role="admin"
    )
    await async_db.commit()
    service = _service(async_db)
    shared = await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))
    view_id = uuid.UUID(shared.id)
    membership.role = "member"
    await async_db.commit()

    listed = await service.list_views(user=admin, workspace_id=workspace.id, page=REQUESTS)
    team = next(view for view in listed.data if view.name == "Team")
    assert (listed.can_share, team.can_edit, team.can_delete) == (False, False, True)
    with pytest.raises(SavedViewSharingForbiddenError):
        await service.update_view(
            user=admin, workspace_id=workspace.id, view_id=view_id, request=SavedViewUpdate(query="status=success")
        )
    await _reload(async_db)
    unshared = await service.update_view(
        user=admin, workspace_id=workspace.id, view_id=view_id, request=SavedViewUpdate(shared=False)
    )

    assert unshared.shared is False
    listed = await service.list_views(user=member, workspace_id=workspace.id, page=REQUESTS)
    assert all(view.built_in for view in listed.data)


@pytest.mark.asyncio
async def test_a_manager_deletes_a_view_another_manager_shared(async_db: AsyncSession) -> None:
    organization, workspace, manager, _ = await _world(async_db, "views-shared-delete")
    admin = await create_member(async_db, organization, role="admin", full_name="Ada Admin")
    service = _service(async_db)
    shared = await service.create_view(user=manager, workspace_id=workspace.id, request=_create("Team", shared=True))

    listed = await service.list_views(user=admin, workspace_id=workspace.id, page=REQUESTS)
    assert next(view for view in listed.data if view.name == "Team").can_delete is True
    await service.delete_view(user=admin, workspace_id=workspace.id, view_id=uuid.UUID(shared.id))

    assert (await async_db.execute(select(SavedView))).scalars().all() == []


@pytest.mark.asyncio
async def test_a_workspace_the_caller_cannot_see_is_not_found(async_db: AsyncSession) -> None:
    organization, workspace, _, member = await _world(async_db, "views-isolation")
    _, foreign, foreign_manager, _ = await _world(async_db, "views-foreign")
    private = await create_workspace(
        async_db,
        organization,
        name="Finance",
        owner=await create_member(async_db, organization, role="member", full_name="Fin"),
    )
    service = _service(async_db)
    foreign_view = await service.create_view(
        user=foreign_manager, workspace_id=foreign.id, request=_create("Theirs", shared=True)
    )

    for workspace_id in (foreign.id, private.id, uuid.uuid4()):
        with pytest.raises(WorkspaceNotFoundError):
            await service.list_views(user=member, workspace_id=workspace_id, page=REQUESTS)
        await _reload(async_db)
        with pytest.raises(WorkspaceNotFoundError):
            await service.create_view(user=member, workspace_id=workspace_id, request=_create("Mine"))
        await _reload(async_db)
    # A shared view's id from another tenant reads as absent in the caller's own workspace.
    with pytest.raises(SavedViewNotFoundError):
        await service.delete_view(user=member, workspace_id=workspace.id, view_id=uuid.UUID(foreign_view.id))
    await _reload(async_db)


@pytest.mark.asyncio
async def test_a_query_names_only_the_keys_its_page_keeps(async_db: AsyncSession) -> None:
    _, workspace, _, member = await _world(async_db, "views-keys")
    service = _service(async_db)
    with pytest.raises(SavedViewQueryInvalidError):
        await service.create_view(
            user=member, workspace_id=workspace.id, request=_create("Paged", "status=error&page=3")
        )
    await _reload(async_db)
    # A threshold is the request log's alone.
    with pytest.raises(SavedViewQueryInvalidError):
        await service.create_view(
            user=member, workspace_id=workspace.id, request=_create("Pricey", "cost_gt=0.4", page=SESSIONS)
        )
    await _reload(async_db)
    # So is the grouping.
    with pytest.raises(SavedViewQueryInvalidError):
        await service.create_view(
            user=member, workspace_id=workspace.id, request=_create("By key", "group=api_key", page=SESSIONS)
        )
    await _reload(async_db)
    view = await service.create_view(
        user=member, workspace_id=workspace.id, request=_create("Pricey", "cost_gt=0.4&model=a&model=b&group=model")
    )
    with pytest.raises(SavedViewQueryInvalidError):
        await service.update_view(
            user=member,
            workspace_id=workspace.id,
            view_id=uuid.UUID(view.id),
            request=SavedViewUpdate(query="request=abc"),
        )
    await _reload(async_db)


@pytest.mark.asyncio
async def test_names_are_unique_per_person_and_page_ignoring_case(async_db: AsyncSession) -> None:
    _, workspace, manager, member = await _world(async_db, "views-names")
    service = _service(async_db)
    await service.create_view(user=member, workspace_id=workspace.id, request=_create("Slow"))
    with pytest.raises(SavedViewNameTakenError):
        await service.create_view(user=member, workspace_id=workspace.id, request=_create("slow "))
    await _reload(async_db)
    # Another page, and another person, may use the name.
    await service.create_view(user=member, workspace_id=workspace.id, request=_create("Slow", "", page=SESSIONS))
    await service.create_view(user=manager, workspace_id=workspace.id, request=_create("Slow"))


@pytest.mark.asyncio
async def test_a_person_keeps_a_bounded_number_of_views_per_page(async_db: AsyncSession) -> None:
    _, workspace, _, member = await _world(async_db, "views-limit")
    service = _service(async_db)
    for index in range(MAX_VIEWS_PER_PAGE):
        await service.create_view(user=member, workspace_id=workspace.id, request=_create(f"View {index}"))
    with pytest.raises(SavedViewLimitReachedError):
        await service.create_view(user=member, workspace_id=workspace.id, request=_create("One more"))
    await _reload(async_db)


async def _workspace_admin(db: AsyncSession, organization: Organization, workspace: Workspace) -> User:
    """A plain member of the organization who manages ``workspace`` through its own membership."""
    admin = await create_member(db, organization, role="member", full_name="Wes Admin")
    await WorkspaceMemberRepository(db).create(workspace_id=workspace.id, user_id=admin.id, role="admin")
    await db.commit()
    return admin


async def _remaining(db: AsyncSession) -> list[tuple[str, uuid.UUID | None]]:
    rows = (await db.execute(select(SavedView.name, SavedView.user_id).order_by(SavedView.name))).all()
    return [(name, user_id) for name, user_id in rows]


@pytest.mark.asyncio
async def test_leaving_a_workspace_keeps_shared_views_and_removes_private_ones(async_db: AsyncSession) -> None:
    organization, workspace, manager, member = await _world(async_db, "views-leave")
    admin = await _workspace_admin(async_db, organization, workspace)
    service = _service(async_db)
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Mine"))
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))

    uow = UnitOfWork(async_db)
    workspaces = WorkspaceService(async_db, uow=uow, membership_listener=get_membership_listener(uow))
    await workspaces.remove_member(user=manager, workspace_id=workspace.id, user_id=admin.id)

    assert await _remaining(async_db) == [("Team", admin.id)]
    for caller, manages in ((manager, True), (member, False)):
        listed = await service.list_views(user=caller, workspace_id=workspace.id, page=REQUESTS)
        team = next(view for view in listed.data if view.name == "Team")
        assert (team.owner_name, team.owner_left, team.can_edit, team.can_delete) == (
            "Wes Admin",
            True,
            manages,
            manages,
        )


@pytest.mark.asyncio
async def test_losing_an_organization_role_keeps_shared_views_and_removes_private_ones(
    async_db: AsyncSession,
) -> None:
    organization, workspace, manager, _ = await _world(async_db, "views-org-demoted")
    admin = await create_member(async_db, organization, role="admin", full_name="Ada Admin")
    await async_db.commit()
    service = _service(async_db)
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Mine"))
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))

    uow = UnitOfWork(async_db)
    organizations = OrganizationService(async_db, uow=uow, membership_listener=get_membership_listener(uow))
    membership = await organizations.members.get_active_by_organization_and_user(organization.id, admin.id)
    assert membership is not None
    await organizations.update_active_organization_member_for_user(
        user=manager,
        organization_member_id=membership.id,
        request=ActiveOrganizationMemberUpdateRequest(role="member"),
        sso_enforcement=NO_SSO_ENFORCEMENT,
        open_signup=False,
    )

    assert await _remaining(async_db) == [("Team", admin.id)]
    listed = await service.list_views(user=manager, workspace_id=workspace.id, page=REQUESTS)
    team = next(view for view in listed.data if view.name == "Team")
    assert (team.owner_left, team.can_edit, team.can_delete) == (True, True, True)


async def _delete_account(db: AsyncSession, identity: User) -> None:
    """What account deletion does to saved views: the private ones removed, then the identity row."""
    uow = UnitOfWork(db)
    async with uow:
        await SavedViewAccountListener(SavedViewRepository(uow)).forget_account(identity.id)
    await db.execute(delete(User).where(User.id == identity.id))  # type: ignore[arg-type]
    await db.commit()


@pytest.mark.asyncio
async def test_deleting_an_account_keeps_its_shared_views_without_an_owner(async_db: AsyncSession) -> None:
    organization, workspace, manager, _ = await _world(async_db, "views-delete")
    admin = await _workspace_admin(async_db, organization, workspace)
    service = _service(async_db)
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Mine"))
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))
    await service.create_view(user=manager, workspace_id=workspace.id, request=_create("Kept"))

    await _delete_account(async_db, admin)

    assert await _remaining(async_db) == [("Kept", manager.id), ("Team", None)]


@pytest.mark.asyncio
async def test_a_manager_keeps_a_shared_view_whose_owner_is_gone(async_db: AsyncSession) -> None:
    organization, workspace, manager, member = await _world(async_db, "views-ownerless")
    admin = await _workspace_admin(async_db, organization, workspace)
    service = _service(async_db)
    shared = await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))
    view_id = uuid.UUID(shared.id)
    await _delete_account(async_db, admin)

    listed = await service.list_views(user=member, workspace_id=workspace.id, page=REQUESTS)
    team = next(view for view in listed.data if view.name == "Team")
    assert (team.owner_name, team.owner_left, team.can_edit, team.can_delete) == (None, True, False, False)
    with pytest.raises(SavedViewSharingForbiddenError):
        await service.update_view(
            user=member, workspace_id=workspace.id, view_id=view_id, request=SavedViewUpdate(name="Ours")
        )
    await _reload(async_db)
    with pytest.raises(SavedViewNotYoursError):
        await service.delete_view(user=member, workspace_id=workspace.id, view_id=view_id)
    await _reload(async_db)

    renamed = await service.update_view(
        user=manager,
        workspace_id=workspace.id,
        view_id=view_id,
        request=SavedViewUpdate(name="Team errors", query="status=success"),
    )
    assert (renamed.name, renamed.query, renamed.owner_left, renamed.can_edit) == (
        "Team errors",
        "status=success",
        True,
        True,
    )
    with pytest.raises(SavedViewOwnerLeftError):
        await service.update_view(
            user=manager, workspace_id=workspace.id, view_id=view_id, request=SavedViewUpdate(shared=False)
        )
    await _reload(async_db)
    await service.delete_view(user=manager, workspace_id=workspace.id, view_id=view_id)

    assert await _remaining(async_db) == []


@pytest.mark.asyncio
async def test_renaming_a_departed_owners_view_onto_another_of_their_names_says_whose_it_is(
    async_db: AsyncSession,
) -> None:
    organization, workspace, manager, _ = await _world(async_db, "views-left-name")
    admin = await _workspace_admin(async_db, organization, workspace)
    service = _service(async_db)
    await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))
    ops = await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Ops", shared=True))
    uow = UnitOfWork(async_db)
    workspaces = WorkspaceService(async_db, uow=uow, membership_listener=get_membership_listener(uow))
    await workspaces.remove_member(user=manager, workspace_id=workspace.id, user_id=admin.id)

    with pytest.raises(SavedViewNameTakenError, match="former owner already has a view named 'team'"):
        await service.update_view(
            user=manager, workspace_id=workspace.id, view_id=uuid.UUID(ops.id), request=SavedViewUpdate(name="team")
        )


@pytest.mark.asyncio
async def test_a_shared_view_is_its_owners_again_once_they_return(async_db: AsyncSession) -> None:
    organization, workspace, manager, _ = await _world(async_db, "views-return")
    admin = await _workspace_admin(async_db, organization, workspace)
    service = _service(async_db)
    shared = await service.create_view(user=admin, workspace_id=workspace.id, request=_create("Team", shared=True))
    uow = UnitOfWork(async_db)
    workspaces = WorkspaceService(async_db, uow=uow, membership_listener=get_membership_listener(uow))
    await workspaces.remove_member(user=manager, workspace_id=workspace.id, user_id=admin.id)
    await WorkspaceMemberRepository(async_db).create(workspace_id=workspace.id, user_id=admin.id, role="admin")
    await async_db.commit()

    listed = await service.list_views(user=manager, workspace_id=workspace.id, page=REQUESTS)
    team = next(view for view in listed.data if view.id == shared.id)
    assert (team.owner_left, team.can_edit) == (False, False)
    listed = await service.list_views(user=admin, workspace_id=workspace.id, page=REQUESTS)
    team = next(view for view in listed.data if view.id == shared.id)
    assert (team.is_mine, team.owner_left, team.can_edit) == (True, False, True)


def _default_workspace_id(client: TestClient, headers: dict[str, str]) -> str:
    listed = client.get(f"{API_ROOT}/workspaces", headers=headers)
    assert listed.status_code == 200, listed.text
    workspace_id: str = listed.json()["data"][0]["id"]
    return workspace_id


def test_the_operator_saves_renames_shares_and_deletes_a_view(
    client: TestClient, master_key_header: dict[str, str]
) -> None:
    base = f"{API_ROOT}/workspaces/{_default_workspace_id(client, master_key_header)}/saved-views"

    created = client.post(
        base,
        json={"page": "requests", "name": "Failures", "query": "range=7d&status=error"},
        headers=master_key_header,
    )
    assert created.status_code == 201, created.text
    view = created.json()
    assert (view["is_mine"], view["shared"], view["built_in"]) == (True, False, False)

    renamed = client.patch(f"{base}/{view['id']}", json={"name": "Errors", "shared": True}, headers=master_key_header)
    assert renamed.status_code == 200, renamed.text
    assert (renamed.json()["name"], renamed.json()["shared"]) == ("Errors", True)

    listed = client.get(base, params={"page": "requests"}, headers=master_key_header)
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["can_share"] is True
    assert [row["name"] for row in body["data"] if not row["built_in"]] == ["Errors"]
    assert client.get(base, params={"page": "sessions"}, headers=master_key_header).json()["data"][0]["name"] == (
        "All sessions"
    )

    assert client.delete(f"{base}/{view['id']}", headers=master_key_header).status_code == 204
    assert client.delete(f"{base}/{view['id']}", headers=master_key_header).status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"page": "usage", "name": "Wrong page", "query": ""},
        {"page": "requests", "name": "   ", "query": ""},
        {"page": "requests", "name": "Path", "query": "/requests?status=error"},
        {"page": "requests", "name": "Fragment", "query": "status=error#top"},
        {"page": "requests", "name": "Not pairs", "query": "status"},
        {"page": "requests", "name": "Long", "query": "q=" + "a" * 2000},
        {"page": "requests", "name": "Unknown key", "query": "size=500"},
    ],
)
def test_a_malformed_view_is_refused(
    client: TestClient, master_key_header: dict[str, str], body: dict[str, str]
) -> None:
    base = f"{API_ROOT}/workspaces/{_default_workspace_id(client, master_key_header)}/saved-views"
    response = client.post(base, json=body, headers=master_key_header)
    assert response.status_code == 422, response.text


def test_a_workspace_that_does_not_exist_is_not_found(client: TestClient, master_key_header: dict[str, str]) -> None:
    response = client.get(
        f"{API_ROOT}/workspaces/{uuid.uuid4()}/saved-views", params={"page": "requests"}, headers=master_key_header
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_a_user_merge_moves_views_onto_the_target_and_refuses_a_shared_name(async_db: AsyncSession) -> None:
    organization, workspace, manager, member = await _world(async_db, "views-merge")
    service = _service(async_db)
    await service.create_view(user=member, workspace_id=workspace.id, request=_create("Slow"))
    await service.create_view(user=member, workspace_id=workspace.id, request=_create("Errors"))
    uow = UnitOfWork(async_db)
    listener = SavedViewUserMergeListener(SavedViewRepository(uow))

    async def merged(source: str, target: str, *, preview: bool) -> object:
        async with uow:
            return await listener.user_merged(source, target, preview=preview, resumed=False)

    async def elsewhere(user_id: str, workspace_ids: list[uuid.UUID]) -> list[str]:
        async with uow:
            return await listener.rows_elsewhere(user_id, workspace_ids)

    assert await merged("legacy-id", str(manager.id), preview=True) == {"saved_views": 0}
    assert await elsewhere(str(member.id), [workspace.id]) == []
    assert await elsewhere(str(member.id), [uuid.uuid4()]) == ["saved_views"]
    assert await merged(str(member.id), str(manager.id), preview=True) == {"saved_views": 2}

    await service.create_view(user=manager, workspace_id=workspace.id, request=_create("slow"))
    with pytest.raises(UserMergeRefusedError):
        await merged(str(member.id), str(manager.id), preview=True)
    await _reload(async_db)

    other = await create_member(async_db, organization, role="member", full_name="Other")
    assert await merged(str(member.id), str(other.id), preview=False) == {"saved_views": 2}
    owners = (await async_db.execute(select(SavedView.user_id).where(SavedView.user_id == other.id))).scalars().all()
    assert len(owners) == 2


def test_a_private_view_cannot_lose_its_owner(db_session) -> None:
    """The schema refuses an ownerless private view: nobody could see or delete it."""
    from sqlalchemy import text
    from sqlalchemy.exc import IntegrityError

    workspace_id = db_session.execute(text("SELECT id FROM workspace LIMIT 1")).scalar_one()
    with pytest.raises(IntegrityError):
        db_session.execute(
            text(
                "INSERT INTO saved_views (id, user_id, workspace_id, page, name, query, shared) "
                "VALUES (:id, NULL, :workspace, 'requests', 'stray', '', false)"
            ),
            {"id": uuid.uuid4(), "workspace": workspace_id},
        )
        db_session.flush()
    db_session.rollback()
