"""The organization-scoped usage reads see the caller's own organization and no more.

``/api/v1/usage`` is deployment-wide and operator-only since #821. These routes are
the tenant's half of it (otari#837), and the whole of their correctness is that
the row set is decided by the caller's membership rather than by anything the
request carries. So the suite is written against a world holding *two*
organizations with traffic in both, and every assertion names the rows that must
be absent rather than counting the ones that came back: a count can match by
accident, and "beta's model is not in this response" cannot.

Four things are asserted for each of the four routes:

- an owner reads every workspace in their organization, and none outside it;
- a member reads their own requests in the workspaces they belong to: not the
  sibling workspace they do not belong to, and not other people's requests in
  the workspace they share;
- a workspace owner or admin reads everyone's requests in the workspace they
  manage, and only their own in any other;
- ``workspace_id`` narrows and never widens, answering 404 outside the scope the
  way a workspace that does not exist does;
- the scope follows the *membership*, not the ``active_organization_id`` pointer,
  so pointing an identity at an organization it does not belong to grants
  nothing.

The last group is the control: the deployment-wide route must still refuse an
organization owner. A change that made these pass by loosening that gate would
have reopened otari-ai#1880, so it is asserted here as well as in
``test_deployment_operator_gate.py``.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import status
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from sqlmodel import col

from gateway.core.config import API_ROOT
from gateway.models.tenancy import DashboardSession, Organization, OrganizationMember, User, Workspace, WorkspaceMember
from gateway.models.usage import UsageLog
from gateway.models.users import User as AttributionUser
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

# Every read this router serves. Parametrized rather than asserted once, because
# a scope applied to the list and forgotten on the summary would leak an
# organization's spend through its aggregates while the log looked correct.
_SCOPED_PATHS = [
    f"{API_ROOT}/organizations/me/usage",
    f"{API_ROOT}/organizations/me/usage/count",
    f"{API_ROOT}/organizations/me/usage/summary",
    f"{API_ROOT}/organizations/me/usage/series?group_by=model",
]


@dataclass
class _World:
    """Two organizations, their workspaces, and one session cookie per identity."""

    alpha: uuid.UUID
    beta: uuid.UUID
    workspaces: dict[str, uuid.UUID] = field(default_factory=dict)
    sessions: dict[str, str] = field(default_factory=dict)
    users: dict[str, uuid.UUID] = field(default_factory=dict)


# Model names double as row identity: every assertion below is "these models and
# no others", which is what makes a leak visible rather than merely miscounted.
_ALPHA_ONE_MODELS = ("alpha-one-a", "alpha-one-b")
_ALPHA_TWO_MODELS = ("alpha-two-a",)
_BETA_MODELS = ("beta-one-a", "beta-one-b")
# Billed to the member and the viewer, in the workspace they share with the
# unattributed rows above.
_ALPHA_ONE_MEMBER_MODELS = ("alpha-one-member",)
_ALPHA_ONE_VIEWER_MODELS = ("alpha-one-viewer",)
# Billed to the member, in the workspace they do not belong to: theirs, and still
# outside their scope.
_ALPHA_TWO_MEMBER_MODELS = ("alpha-two-member",)
# Billed to the workspace admin, who manages Alpha one and is a plain member of
# Alpha two.
_ALPHA_ONE_WS_ADMIN_MODELS = ("alpha-one-ws-admin",)
_ALPHA_TWO_WS_ADMIN_MODELS = ("alpha-two-ws-admin",)
_ALPHA_ONE_EVERYONE = (
    _ALPHA_ONE_MODELS + _ALPHA_ONE_MEMBER_MODELS + _ALPHA_ONE_VIEWER_MODELS + _ALPHA_ONE_WS_ADMIN_MODELS
)
_ALPHA_MODELS = _ALPHA_ONE_EVERYONE + _ALPHA_TWO_MODELS + _ALPHA_TWO_MEMBER_MODELS + _ALPHA_TWO_WS_ADMIN_MODELS


def _identity(
    session: Session,
    *,
    email: str,
    organization_id: uuid.UUID,
    role: str = "member",
    is_superuser: bool = False,
    workspace_ids: tuple[uuid.UUID, ...] = (),
    managed_workspace_ids: tuple[uuid.UUID, ...] = (),
    membership: bool = True,
) -> tuple[uuid.UUID, str]:
    """Create an identity with a live dashboard session, and return its cookie.

    ``membership=False`` builds the case the pointer test needs: an identity
    whose ``active_organization_id`` names an organization it holds no membership
    in, which is the shape a stolen or stale pointer would have.
    """
    user = User(
        email=email,
        full_name=email.split("@")[0].title(),
        active_organization_id=organization_id,
        is_superuser=is_superuser,
    )
    session.add(user)
    session.commit()
    session.refresh(user)

    if membership:
        session.add(
            OrganizationMember(
                organization_id=organization_id,
                user_id=user.id,
                role=role,
                status="active",
            )
        )
    for workspace_id, workspace_role in [(w, "member") for w in workspace_ids] + [
        (w, "admin") for w in managed_workspace_ids
    ]:
        session.add(
            WorkspaceMember(
                workspace_id=workspace_id,
                user_id=user.id,
                role=workspace_role,
                status="active",
            )
        )

    token = f"otari-sess-{email}"
    session.add(
        DashboardSession(
            token_hash=hash_session_token(token),
            user_id=user.id,
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(hours=12),
        )
    )
    session.commit()
    return user.id, token


def _usage_rows(
    session: Session, workspace_id: uuid.UUID, models: tuple[str, ...], *, user_id: uuid.UUID | None = None
) -> None:
    for model in models:
        session.add(
            UsageLog(
                id=str(uuid.uuid4()),
                workspace_id=workspace_id,
                user_id=str(user_id) if user_id is not None else None,
                model=model,
                provider="p",
                endpoint="/v1/chat/completions",
                source="gateway",
                status="success",
                total_tokens=10,
                timestamp=datetime.now(UTC),
            )
        )
    session.commit()


@pytest.fixture
def world(client: TestClient, master_key_header: dict[str, str], db_session_factory: Callable[[], Session]) -> _World:
    """Two tenants with traffic in both, and the identities that read them."""
    # One master-key call provisions the tenancy root, so the organizations built
    # below sit beside a real default rather than replacing it.
    assert client.get(f"{API_ROOT}/organizations/me", headers=master_key_header).status_code == status.HTTP_200_OK

    session = db_session_factory()
    try:
        alpha = Organization(name="Alpha", slug="alpha")
        beta = Organization(name="Beta", slug="beta")
        session.add_all([alpha, beta])
        session.commit()
        session.refresh(alpha)
        session.refresh(beta)

        alpha_one = Workspace(name="Alpha one", organization_id=alpha.id)
        alpha_two = Workspace(name="Alpha two", organization_id=alpha.id)
        beta_one = Workspace(name="Beta one", organization_id=beta.id)
        session.add_all([alpha_one, alpha_two, beta_one])
        session.commit()
        for workspace in (alpha_one, alpha_two, beta_one):
            session.refresh(workspace)

        _usage_rows(session, alpha_one.id, _ALPHA_ONE_MODELS)
        _usage_rows(session, alpha_two.id, _ALPHA_TWO_MODELS)
        _usage_rows(session, beta_one.id, _BETA_MODELS)

        built = _World(alpha=alpha.id, beta=beta.id)
        built.workspaces = {"alpha_one": alpha_one.id, "alpha_two": alpha_two.id, "beta_one": beta_one.id}
        people = {
            "alpha_owner": _identity(session, email="owner@alpha.test", organization_id=alpha.id, role="owner"),
            "alpha_admin": _identity(session, email="admin@alpha.test", organization_id=alpha.id, role="admin"),
            # Belongs to one of alpha's two workspaces, which is the case the
            # member arm exists for.
            "alpha_member": _identity(
                session,
                email="member@alpha.test",
                organization_id=alpha.id,
                workspace_ids=(alpha_one.id,),
            ),
            # The fourth role, and outside MANAGEMENT_ROLES like ``member``, so
            # it must take the workspace branch rather than the whole-tenant one.
            "alpha_viewer": _identity(
                session,
                email="viewer@alpha.test",
                organization_id=alpha.id,
                role="viewer",
                workspace_ids=(alpha_one.id,),
            ),
            # An organization member who administers Alpha one and only belongs to Alpha two.
            "alpha_ws_admin": _identity(
                session,
                email="ws-admin@alpha.test",
                organization_id=alpha.id,
                workspace_ids=(alpha_two.id,),
                managed_workspace_ids=(alpha_one.id,),
            ),
            # In the organization, in none of its workspaces.
            "alpha_newcomer": _identity(session, email="new@alpha.test", organization_id=alpha.id),
            "beta_owner": _identity(session, email="owner@beta.test", organization_id=beta.id, role="owner"),
            # Points at alpha, belongs to nothing.
            "impostor": _identity(
                session,
                email="impostor@nowhere.test",
                organization_id=alpha.id,
                membership=False,
            ),
            "superuser": _identity(
                session,
                email="root@beta.test",
                organization_id=beta.id,
                role="owner",
                is_superuser=True,
            ),
        }
        built.users = {name: user_id for name, (user_id, _) in people.items()}
        # A usage row names the attribution user it was billed to, which is keyed
        # on the identity's id, so those rows exist before the usage that cites them.
        session.add_all(
            [
                AttributionUser(user_id=str(built.users[who]), alias=who)
                for who in ("alpha_member", "alpha_viewer", "alpha_ws_admin")
            ]
        )
        session.commit()
        _usage_rows(session, alpha_one.id, _ALPHA_ONE_MEMBER_MODELS, user_id=built.users["alpha_member"])
        _usage_rows(session, alpha_one.id, _ALPHA_ONE_VIEWER_MODELS, user_id=built.users["alpha_viewer"])
        _usage_rows(session, alpha_two.id, _ALPHA_TWO_MEMBER_MODELS, user_id=built.users["alpha_member"])
        _usage_rows(session, alpha_one.id, _ALPHA_ONE_WS_ADMIN_MODELS, user_id=built.users["alpha_ws_admin"])
        _usage_rows(session, alpha_two.id, _ALPHA_TWO_WS_ADMIN_MODELS, user_id=built.users["alpha_ws_admin"])
        built.sessions = {name: token for name, (_, token) in people.items()}
        return built
    finally:
        session.close()


def _as(client: TestClient, world: _World, who: str, path: str) -> tuple[int, object]:
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions[who])
    try:
        response = client.get(path)
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else None
        return response.status_code, body
    finally:
        client.cookies.clear()


def _models_listed(client: TestClient, world: _World, who: str, query: str = "") -> set[str]:
    code, body = _as(client, world, who, f"{API_ROOT}/organizations/me/usage{query}")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, list)
    return {row["model"] for row in body}


def _models_summarized(client: TestClient, world: _World, who: str, query: str = "") -> set[str]:
    code, body = _as(client, world, who, f"{API_ROOT}/organizations/me/usage/summary{query}")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    return {row["key"] for row in body["by_model"] if not row.get("is_other")}


# =============================================================================
# How much of the organization each role reads
# =============================================================================


@pytest.mark.parametrize("who", ["alpha_owner", "alpha_admin"])
def test_an_owner_or_admin_reads_every_workspace_in_their_own_organization(
    client: TestClient, world: _World, who: str
) -> None:
    """The management arm: the whole tenant, everyone's requests, and nothing outside it."""
    assert _models_listed(client, world, who) == set(_ALPHA_MODELS)


@pytest.mark.parametrize("who", ["alpha_owner", "alpha_admin"])
def test_an_owner_or_admin_reads_no_other_organizations_rows(client: TestClient, world: _World, who: str) -> None:
    """Stated on its own, because it is the claim the whole change rests on."""
    assert _models_listed(client, world, who).isdisjoint(_BETA_MODELS)
    assert _models_summarized(client, world, who).isdisjoint(_BETA_MODELS)


def test_a_member_reads_only_the_workspaces_they_belong_to(client: TestClient, world: _World) -> None:
    """The member arm, and the sibling workspace in the same organization is the point.

    ``alpha_member`` belongs to Alpha one and not Alpha two. Both are their
    organization's, so an implementation that scoped to the organization alone
    would pass every other test in this file and fail this one. Alpha two also
    holds a row billed to them, which must stay hidden: their own requests are
    read within their workspaces, not instead of them.
    """
    listed = _models_listed(client, world, "alpha_member")
    assert listed == set(_ALPHA_ONE_MEMBER_MODELS)
    assert listed.isdisjoint(_ALPHA_TWO_MODELS + _ALPHA_TWO_MEMBER_MODELS)
    assert listed.isdisjoint(_BETA_MODELS)


@pytest.mark.parametrize("query", ["", "?workspace_id={alpha_one}"])
def test_a_member_reads_only_their_own_requests_in_a_shared_workspace(
    client: TestClient, world: _World, query: str
) -> None:
    """Alpha one holds other people's requests as well as the member's, and those stay hidden.

    Both ways of reaching the workspace, the whole scope and the explicit filter,
    because they build the condition on separate branches.
    """
    query = query.format(alpha_one=world.workspaces["alpha_one"])
    listed = _models_listed(client, world, "alpha_member", query)
    assert listed == set(_ALPHA_ONE_MEMBER_MODELS)
    assert listed.isdisjoint(_ALPHA_ONE_MODELS + _ALPHA_ONE_VIEWER_MODELS)
    assert _models_summarized(client, world, "alpha_member", query) == set(_ALPHA_ONE_MEMBER_MODELS)


def test_a_members_search_never_reaches_outside_their_scope(client: TestClient, world: _World) -> None:
    """Search ORs across columns, and the scope is ANDed around all of it.

    The viewer's model shares the member's workspace and matches the search, so a
    search that escaped its scope would surface it here.
    """
    assert _models_listed(client, world, "alpha_member", "?q=alpha-one") == set(_ALPHA_ONE_MEMBER_MODELS)
    assert _models_listed(client, world, "alpha_member", "?q=viewer") == set()
    assert _models_summarized(client, world, "alpha_member", "?q=viewer") == set()
    # Matching the member's own alias finds only the rows the scope already allows:
    # their row in alpha two stays out, since they belong to alpha one alone.
    assert _models_listed(client, world, "alpha_member", "?q=alpha_member") == set(_ALPHA_ONE_MEMBER_MODELS)


def test_a_viewer_is_scoped_like_a_member_and_not_like_an_admin(client: TestClient, world: _World) -> None:
    """``viewer`` is the fourth role and is outside ``MANAGEMENT_ROLES``.

    Pinned separately from ``member`` because the two reach the workspace branch
    through different values, and a scope that tested for ``member`` by name
    rather than for management would hand a viewer the whole organization.
    """
    listed = _models_listed(client, world, "alpha_viewer")
    assert listed == set(_ALPHA_ONE_VIEWER_MODELS)
    assert listed.isdisjoint(_ALPHA_TWO_MODELS + _ALPHA_ONE_MODELS)


def test_a_workspace_admin_reads_everyones_requests_in_the_workspace_they_manage(
    client: TestClient, world: _World
) -> None:
    """Named or not, the managed workspace is read whole, members' and viewers' rows included."""
    alpha_one = world.workspaces["alpha_one"]
    assert _models_listed(client, world, "alpha_ws_admin", f"?workspace_id={alpha_one}") == set(_ALPHA_ONE_EVERYONE)
    assert _models_summarized(client, world, "alpha_ws_admin", f"?workspace_id={alpha_one}") == set(_ALPHA_ONE_EVERYONE)
    listed = _models_listed(client, world, "alpha_ws_admin")
    assert set(_ALPHA_ONE_EVERYONE) <= listed


def test_a_workspace_admin_reads_only_their_own_requests_in_another_workspace(
    client: TestClient, world: _World
) -> None:
    """Managing Alpha one widens Alpha one and nothing else, on either branch of the scope."""
    alpha_two = world.workspaces["alpha_two"]
    assert _models_listed(client, world, "alpha_ws_admin", f"?workspace_id={alpha_two}") == set(
        _ALPHA_TWO_WS_ADMIN_MODELS
    )
    listed = _models_listed(client, world, "alpha_ws_admin")
    assert listed == set(_ALPHA_ONE_EVERYONE + _ALPHA_TWO_WS_ADMIN_MODELS)
    assert listed.isdisjoint(_ALPHA_TWO_MODELS + _ALPHA_TWO_MEMBER_MODELS + _BETA_MODELS)
    assert _models_summarized(client, world, "alpha_ws_admin") == listed


@pytest.mark.parametrize("query", ["", "?workspace_id={alpha_one}", "?workspace_id={alpha_two}"])
def test_a_workspace_admins_aggregates_carry_the_same_scope_as_their_list(
    client: TestClient, world: _World, query: str
) -> None:
    """The count, the groups and the series read the rows the list does, and no more."""
    query = query.format(**{name: str(workspace) for name, workspace in world.workspaces.items()})
    listed = _models_listed(client, world, "alpha_ws_admin", query)
    joiner = "&" if query else "?"

    code, body = _as(client, world, "alpha_ws_admin", f"{API_ROOT}/organizations/me/usage/count{query}")
    assert code == status.HTTP_200_OK, body
    assert body == {"total": len(listed)}

    code, body = _as(
        client, world, "alpha_ws_admin", f"{API_ROOT}/organizations/me/usage/groups{query}{joiner}group_by=model"
    )
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert {group["key"] for group in body["groups"]} == listed

    code, body = _as(
        client, world, "alpha_ws_admin", f"{API_ROOT}/organizations/me/usage/series{query}{joiner}group_by=model"
    )
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert {group["key"] for group in body["groups"] if not group.get("is_other")} == listed


def test_a_suspended_workspace_admin_membership_stops_widening_the_workspace(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """Management is read from the active membership, so suspending it takes the workspace back."""
    session = db_session_factory()
    try:
        membership = (
            session.query(WorkspaceMember)
            .filter(col(WorkspaceMember.workspace_id) == world.workspaces["alpha_one"])
            .filter(col(WorkspaceMember.user_id) == world.users["alpha_ws_admin"])
            .one()
        )
        membership.status = "suspended"
        session.add(membership)
        session.commit()
    finally:
        session.close()

    assert _models_listed(client, world, "alpha_ws_admin") == set(_ALPHA_TWO_WS_ADMIN_MODELS)


@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("DELETE", f"{API_ROOT}/usage", {"ids": ["x"]}),
        (
            "POST",
            f"{API_ROOT}/usage/set-price",
            {"ids": ["x"], "input_price_per_million": 1, "output_price_per_million": 1},
        ),
    ],
)
def test_a_workspace_admin_cannot_reach_the_bulk_usage_mutations(
    client: TestClient, world: _World, method: str, path: str, payload: dict[str, object]
) -> None:
    """Reading a workspace's requests grants nothing on the operator-only writes."""
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions["alpha_ws_admin"])
    try:
        response = client.request(method, path, json=payload)
    finally:
        client.cookies.clear()
    assert response.status_code == status.HTTP_403_FORBIDDEN, response.text


def test_a_member_of_no_workspace_reads_an_empty_page_rather_than_a_refusal(client: TestClient, world: _World) -> None:
    """Nothing was refused; there is simply nothing here yet."""
    code, body = _as(client, world, "alpha_newcomer", f"{API_ROOT}/organizations/me/usage")
    assert code == status.HTTP_200_OK, body
    assert body == []

    code, body = _as(client, world, "alpha_newcomer", f"{API_ROOT}/organizations/me/usage/count")
    assert code == status.HTTP_200_OK, body
    assert body == {"total": 0}


def test_a_member_of_no_workspace_gets_empty_aggregates_rather_than_an_error(client: TestClient, world: _World) -> None:
    """The empty scope reaches a ``GROUP BY`` rather than a row filter here.

    ``/summary`` and ``/series`` fold their breakdowns over the same conditions,
    so a scope of "nothing" has to produce zeroed totals and empty groups rather
    than a division by zero or a fold over an empty top-N set.
    """
    code, body = _as(client, world, "alpha_newcomer", f"{API_ROOT}/organizations/me/usage/summary")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert body["totals"]["request_count"] == 0
    assert body["totals"]["cost"] == 0
    assert body["by_model"] == []
    assert body["series"] == []

    for group_by in ("model", "user_id", "api_key_id", "source"):
        code, body = _as(
            client, world, "alpha_newcomer", f"{API_ROOT}/organizations/me/usage/series?group_by={group_by}"
        )
        assert code == status.HTTP_200_OK, (group_by, body)
        assert isinstance(body, dict)
        assert body["groups"] == [], group_by
        assert body["points"] == [], group_by


def test_a_suspended_workspace_membership_stops_granting_the_workspace(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """The scope reads active memberships only, so suspending one takes the rows back.

    Distinct from removing the organization membership, which would refuse the
    whole surface: this caller is still a member of Alpha and still reads it,
    with one workspace fewer in it.
    """
    assert _models_listed(client, world, "alpha_member") == set(_ALPHA_ONE_MEMBER_MODELS)

    session = db_session_factory()
    try:
        membership = (
            session.query(WorkspaceMember)
            .filter(col(WorkspaceMember.workspace_id) == world.workspaces["alpha_one"])
            .filter(col(WorkspaceMember.user_id) == world.users["alpha_member"])
            .one()
        )
        membership.status = "suspended"
        session.add(membership)
        session.commit()
    finally:
        session.close()

    assert _models_listed(client, world, "alpha_member") == set()
    # Still their organization: an empty page, not a refusal.
    code, _ = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage")
    assert code == status.HTTP_200_OK


def test_a_superuser_reads_their_active_organization_and_not_every_tenant(client: TestClient, world: _World) -> None:
    """This router is scoped even for an operator, and so is ``/api/v1/usage``."""
    listed = _models_listed(client, world, "superuser")
    assert listed == set(_BETA_MODELS)
    assert listed.isdisjoint(_ALPHA_ONE_MODELS)


# =============================================================================
# The workspace filter narrows and cannot widen
# =============================================================================


def test_a_workspace_filter_inside_the_scope_narrows_the_read(client: TestClient, world: _World) -> None:
    query = f"?workspace_id={world.workspaces['alpha_two']}"
    assert _models_listed(client, world, "alpha_owner", query) == set(
        _ALPHA_TWO_MODELS + _ALPHA_TWO_MEMBER_MODELS + _ALPHA_TWO_WS_ADMIN_MODELS
    )


@pytest.mark.parametrize("path", _SCOPED_PATHS)
def test_another_organizations_workspace_is_not_found_on_every_route(
    client: TestClient, world: _World, path: str
) -> None:
    """404 rather than 403 or an empty 200: it must read like a workspace that does not exist."""
    joiner = "&" if "?" in path else "?"
    code, _ = _as(client, world, "alpha_owner", f"{path}{joiner}workspace_id={world.workspaces['beta_one']}")
    assert code == status.HTTP_404_NOT_FOUND


@pytest.mark.parametrize("path", _SCOPED_PATHS)
def test_a_workspace_the_member_does_not_belong_to_is_not_found(client: TestClient, world: _World, path: str) -> None:
    """Alpha two is the caller's own organization's, and still not theirs to name."""
    joiner = "&" if "?" in path else "?"
    code, _ = _as(client, world, "alpha_member", f"{path}{joiner}workspace_id={world.workspaces['alpha_two']}")
    assert code == status.HTTP_404_NOT_FOUND


# =============================================================================
# The scope follows the membership, not the pointer
# =============================================================================


@pytest.mark.parametrize("path", _SCOPED_PATHS)
def test_an_active_organization_pointer_with_no_membership_behind_it_reads_nothing(
    client: TestClient, world: _World, path: str
) -> None:
    """The pointer is not the authority; the membership is.

    ``impostor`` has ``active_organization_id`` set to Alpha and no
    ``OrganizationMember`` row anywhere. If the scope were derived from the
    pointer alone this would return Alpha's traffic.
    """
    code, body = _as(client, world, "impostor", path)
    assert code in {status.HTTP_403_FORBIDDEN, status.HTTP_404_NOT_FOUND}, body


def test_switching_organizations_is_what_moves_the_scope(client: TestClient, world: _World) -> None:
    """And it refuses an organization the caller does not belong to, so it is not a way in."""
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions["alpha_owner"])
    try:
        refused = client.post(f"{API_ROOT}/organizations/me/switch", json={"organization_id": str(world.beta)})
        assert refused.status_code == status.HTTP_404_NOT_FOUND, refused.text
        # And the read is unmoved by the attempt.
        listed = {row["model"] for row in client.get(f"{API_ROOT}/organizations/me/usage").json()}
        assert listed.isdisjoint(_BETA_MODELS)
    finally:
        client.cookies.clear()


# =============================================================================
# The aggregates carry the same scope as the log
# =============================================================================


def test_the_count_never_describes_more_rows_than_the_list_returns(client: TestClient, world: _World) -> None:
    for who, expected in (
        ("alpha_owner", len(_ALPHA_MODELS)),
        ("alpha_member", len(_ALPHA_ONE_MEMBER_MODELS)),
        ("beta_owner", len(_BETA_MODELS)),
    ):
        code, body = _as(client, world, who, f"{API_ROOT}/organizations/me/usage/count")
        assert code == status.HTTP_200_OK, body
        assert body == {"total": expected}, who


def test_the_summary_totals_count_only_the_callers_own_rows(client: TestClient, world: _World) -> None:
    code, body = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage/summary")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert body["totals"]["request_count"] == len(_ALPHA_ONE_MEMBER_MODELS)
    assert _models_summarized(client, world, "alpha_member") == set(_ALPHA_ONE_MEMBER_MODELS)


def test_the_series_splits_only_the_callers_own_rows(client: TestClient, world: _World) -> None:
    code, body = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage/series?group_by=model")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    keys = {group["key"] for group in body["groups"] if not group.get("is_other")}
    assert keys == set(_ALPHA_ONE_MEMBER_MODELS)


def test_the_deployment_publishes_and_scopes_the_surface(client: TestClient, world: _World) -> None:
    """Every test here is the several-organization case.

    The dashboard gates its page on the bootstrap, so both the published surface
    and the reads behind it are pinned: each of the deployment's organizations
    sees only its own rows.
    """
    answered = client.get(f"{API_ROOT}/bootstrap").json()
    assert "organization_usage" in answered["surfaces"]

    # A plain member reads only their own rows in the workspace they belong to.
    assert _models_listed(client, world, "alpha_member") == set(_ALPHA_ONE_MEMBER_MODELS)
    assert _models_listed(client, world, "beta_owner") == set(_BETA_MODELS)


# =============================================================================
# Controls: the deployment-wide route is untouched
# =============================================================================


def test_an_organization_owner_is_still_refused_by_the_deployment_wide_usage_route(
    client: TestClient, world: _World
) -> None:
    """The gate #821 added stays where it is. This is the regression that would matter most."""
    code, _ = _as(client, world, "alpha_owner", f"{API_ROOT}/usage")
    assert code == status.HTTP_403_FORBIDDEN


def test_the_operator_route_reads_the_operators_active_organization(
    client: TestClient, world: _World, master_key_header: dict[str, str]
) -> None:
    """``/api/v1/usage`` follows the rule ``/api/v1/keys`` does: a session reads its active
    organization, and the header master key the default one, which holds neither tenant here."""
    code, body = _as(client, world, "superuser", f"{API_ROOT}/usage")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, list)
    assert {row["model"] for row in body} == set(_BETA_MODELS)

    listed = {row["model"] for row in client.get(f"{API_ROOT}/usage", headers=master_key_header).json()}
    assert listed.isdisjoint(set(_ALPHA_ONE_MODELS) | set(_BETA_MODELS))


@pytest.mark.parametrize(
    "path",
    [
        f"{API_ROOT}/usage/summary",
        f"{API_ROOT}/usage/series?group_by=model",
        f"{API_ROOT}/usage/groups?group_by=model",
        f"{API_ROOT}/usage/latency?group_by=model",
    ],
)
def test_the_operator_aggregates_read_the_operators_active_organization(
    client: TestClient, world: _World, path: str
) -> None:
    """The operator's aggregates carry the scope its list does, or another organization's
    spend leaks through a breakdown while the log looks correct."""
    code, body = _as(client, world, "superuser", path)
    assert code == status.HTTP_200_OK, body
    named = str(body)
    assert any(model in named for model in _BETA_MODELS), body
    assert not any(model in named for model in _ALPHA_MODELS), body


@pytest.mark.parametrize("path", _SCOPED_PATHS)
def test_an_unauthenticated_request_is_refused(client: TestClient, world: _World, path: str) -> None:
    """No credential is a 401, so the scope is never reached with nobody behind it."""
    assert client.get(path).status_code == status.HTTP_401_UNAUTHORIZED


# =============================================================================
# The organization-context contract two sibling issues consume
# =============================================================================


def test_the_context_reports_whether_the_caller_operates_the_deployment(client: TestClient, world: _World) -> None:
    """`deployment_operator` is the answer `GET /api/v1/admin/access` gives, on a read the shell already makes.

    Carried here so the sidebar has no window in which it shows a row it is about
    to retract (otari#836), and so the roster can say which authority its role
    picker sets (otari#838). Asserted against both answers, because a field that
    is always true is indistinguishable from one nothing computes.
    """
    for who, expected in (("alpha_owner", False), ("superuser", True)):
        code, body = _as(client, world, who, f"{API_ROOT}/organizations/me")
        assert code == status.HTTP_200_OK, body
        assert isinstance(body, dict)
        assert body["deployment_operator"] is expected, who


def test_the_context_agrees_with_the_admin_access_endpoint(client: TestClient, world: _World) -> None:
    """Two publishers of one predicate, which is only safe while they cannot disagree."""
    for who in ("alpha_owner", "superuser"):
        _, context = _as(client, world, who, f"{API_ROOT}/organizations/me")
        _, access = _as(client, world, who, f"{API_ROOT}/admin/access")
        assert isinstance(context, dict)
        assert isinstance(access, dict)
        assert context["deployment_operator"] is access["granted"], who


def test_every_response_carrying_the_context_carries_the_operator_answer(client: TestClient, world: _World) -> None:
    """`POST /me/switch` and `PATCH /me` return the shape too, not just `GET /me`.

    The dashboard keeps whichever context it saw last, so a write answering a
    stale `false` would strip an operator's sidebar until the next reload, and a
    stale `true` would leave a member looking at rows the server refuses. Both
    identities are asserted for the reason the read above gives: a field that is
    always true is indistinguishable from one nothing computes.

    Each caller switches to the organization it is already in, which the service
    admits on purpose ("a switcher that re-sent the current row should not have
    to be told off for it") and which keeps this test out of the membership
    graph the rest of the file is about.
    """
    for who, organization, expected in (
        ("alpha_owner", world.alpha, False),
        ("superuser", world.beta, True),
    ):
        client.cookies.set(SESSION_COOKIE_NAME, world.sessions[who])
        try:
            switched = client.post(
                f"{API_ROOT}/organizations/me/switch",
                json={"organization_id": str(organization)},
            )
            renamed = client.patch(f"{API_ROOT}/organizations/me", json={"name": f"Renamed by {who}"})
        finally:
            client.cookies.clear()

        assert switched.status_code == status.HTTP_200_OK, switched.text
        assert renamed.status_code == status.HTTP_200_OK, renamed.text
        assert switched.json()["deployment_operator"] is expected, who
        assert renamed.json()["deployment_operator"] is expected, who


def test_the_context_names_the_caller_it_describes(client: TestClient, world: _World) -> None:
    """The identity behind the standing, which is what a shell draws a person from.

    Nothing else on this contract says *who* is signed in, so the dashboard's
    account control had no name to show and showed a role instead (otari#832).
    Asserted per identity rather than for shape alone: a field filled from the
    wrong identity is the failure that matters here, and one filled from a
    constant would satisfy a shape check.
    """
    for who, email in (
        ("alpha_owner", "owner@alpha.test"),
        ("alpha_member", "member@alpha.test"),
        ("superuser", "root@beta.test"),
    ):
        code, body = _as(client, world, who, f"{API_ROOT}/organizations/me")
        assert code == status.HTTP_200_OK, body
        assert isinstance(body, dict)
        caller = body["caller"]
        assert caller["user_id"] == str(world.users[who]), who
        assert caller["email"] == email, who
        # What `_identity` gives every one of them: the address's local part.
        assert caller["full_name"] == email.split("@")[0].title(), who


def test_the_context_names_an_identity_that_holds_no_address(
    client: TestClient, world: _World, master_key_header: dict[str, str]
) -> None:
    """The local operator, which is the identity a standalone first boot leaves behind.

    It has a name and no email, so a shell that assumed an address would have
    nothing to draw for the one caller every standalone deployment has.
    """
    response = client.get(f"{API_ROOT}/organizations/me", headers=master_key_header)
    assert response.status_code == status.HTTP_200_OK, response.text
    caller = response.json()["caller"]
    assert caller["email"] is None
    assert caller["full_name"]


def test_the_context_reports_whether_provider_keys_can_be_encrypted(client: TestClient, world: _World) -> None:
    """A deployment fact a tenant is allowed to know, because it decides whether their own write works.

    The only endpoint that reported it is operator-gated, so the provider-keys
    page inferred it from a refused request and told an owner to go set an
    environment variable that was already set (otari#839). Readable by a member
    here, which is the whole point.
    """
    code, body = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert isinstance(body["provider_key_encryption_available"], bool)
    # Says whether a key is configured, never anything about its value.
    assert "secret" not in str(body).lower()


def test_another_organizations_names_never_match_a_search(client: TestClient, world: _World) -> None:
    """The alias and key-name subqueries are not tenant-scoped; the scope around them is.

    ``alpha_member`` is the alias of a user who only has rows in alpha, so beta's
    owner searching for it must find nothing rather than learn it exists.
    """
    assert _models_listed(client, world, "beta_owner", "?q=alpha_member") == set()
    assert _models_listed(client, world, "beta_owner", "?q=alpha-one") == set()
    assert _models_listed(client, world, "alpha_owner", "?q=beta-one") == set()


def test_earlier_failed_attempts_are_counted_only_inside_the_callers_scope(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """A member's folded row counts its own absorbed attempt and nobody else's.

    The viewer's absorbed row shares the member's request group, which no real
    request does; it stands in for any row the scope must keep out of the count.
    """
    workspace = world.workspaces["alpha_one"]
    member, viewer = str(world.users["alpha_member"]), str(world.users["alpha_viewer"])
    now = datetime.now(UTC)
    routed = {"workspace_id": workspace, "provider": "p", "endpoint": "/v1/chat/completions", "source": "gateway"}
    session = db_session_factory()
    try:
        session.add_all(
            [
                UsageLog(
                    id="served",
                    user_id=member,
                    model="routed-served",
                    status="success",
                    request_group_id="g",
                    timestamp=now,
                    **routed,
                ),
                UsageLog(
                    id="mine-absorbed",
                    user_id=member,
                    model="routed-first",
                    status="absorbed",
                    request_group_id="g",
                    timestamp=now - timedelta(seconds=2),
                    **routed,
                ),
                UsageLog(
                    id="viewers-absorbed",
                    user_id=viewer,
                    model="routed-first",
                    status="absorbed",
                    request_group_id="g",
                    timestamp=now - timedelta(seconds=1),
                    **routed,
                ),
            ]
        )
        session.commit()
    finally:
        session.close()

    code, body = _as(
        client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage?include_absorbed=false&q=routed"
    )
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, list)
    assert [(row["id"], row["absorbed_attempts"]) for row in body] == [("served", 1)]


def test_a_members_groups_hold_only_their_own_requests(client: TestClient, world: _World) -> None:
    """Grouping runs inside the scope: by user, a member sees one group, their own."""
    code, body = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage/groups?group_by=user")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert [group["key"] for group in body["groups"]] == [str(world.users["alpha_member"])]
    code, body = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage/groups?group_by=model")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert {group["key"] for group in body["groups"]} == set(_ALPHA_ONE_MEMBER_MODELS)


def test_the_organization_list_sorts_and_refines_inside_the_scope(client: TestClient, world: _World) -> None:
    code, body = _as(client, world, "alpha_owner", f"{API_ROOT}/organizations/me/usage?sort=model&order=asc")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, list)
    models = [row["model"] for row in body]
    assert models == sorted(models)
    assert set(models) == set(_ALPHA_MODELS)
    refined = _models_listed(client, world, "alpha_owner", "?exclude_model=alpha-one-a&exclude_model=alpha-two-a")
    assert refined == set(_ALPHA_MODELS) - {"alpha-one-a", "alpha-two-a"}
    code, body = _as(
        client,
        world,
        "alpha_owner",
        f"{API_ROOT}/organizations/me/usage/groups?group_by=model&exclude_model=alpha-one-a",
    )
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert {group["key"] for group in body["groups"]} == set(_ALPHA_MODELS) - {"alpha-one-a"}


def _summary(client: TestClient, world: _World, who: str, query: str) -> dict[str, list[dict[str, object]]]:
    code, body = _as(client, world, who, f"{API_ROOT}/organizations/me/usage/summary{query}")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    return body


def test_a_breakdown_by_workspace_names_only_the_workspaces_in_scope(client: TestClient, world: _World) -> None:
    """An owner sees their organization's workspaces by name; a member, theirs; nobody, another tenant's."""
    owner = _summary(client, world, "alpha_owner", "?dimensions=workspace")
    assert {(row["key"], row["label"]) for row in owner["by_workspace"]} == {
        (str(world.workspaces["alpha_one"]), "Alpha one"),
        (str(world.workspaces["alpha_two"]), "Alpha two"),
    }
    member = _summary(client, world, "alpha_member", "?dimensions=workspace")
    assert [row["key"] for row in member["by_workspace"]] == [str(world.workspaces["alpha_one"])]
    assert member["by_workspace"][0]["requests"] == len(_ALPHA_ONE_MEMBER_MODELS)


def test_a_breakdown_by_channel_counts_only_the_callers_own_rows(client: TestClient, world: _World) -> None:
    member = _summary(client, world, "alpha_member", "?dimensions=channel")
    assert [(row["key"], row["requests"]) for row in member["by_channel"]] == [("api", len(_ALPHA_ONE_MEMBER_MODELS))]


def test_a_series_by_workspace_splits_only_the_workspaces_in_scope(client: TestClient, world: _World) -> None:
    code, body = _as(client, world, "alpha_member", f"{API_ROOT}/organizations/me/usage/series?group_by=workspace")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert {point["key"] for point in body["points"]} == {str(world.workspaces["alpha_one"])}
    assert {group["key"] for group in body["groups"]} == {str(world.workspaces["alpha_one"])}


def test_the_organization_summarys_per_group_extras_read_only_the_callers_rows(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """``p95_by`` and ``session_details`` rank and name a group from the rows in scope, not the whole group."""
    session = db_session_factory()
    try:
        member = str(world.users["alpha_member"])
        for source, latency, user_id in (
            ("codex", 100, member),
            ("codex", 200, member),
            # Someone else's requests in the same session: slower, and from another tool.
            ("claude_code", 90_000, None),
            ("claude_code", 90_000, None),
            ("claude_code", 90_000, None),
        ):
            session.add(
                UsageLog(
                    id=str(uuid.uuid4()),
                    workspace_id=world.workspaces["alpha_one"],
                    user_id=user_id,
                    model="alpha-one-member",
                    provider="p",
                    endpoint="/v1/chat/completions",
                    source=source,
                    source_label="task-1",
                    status="success",
                    latency_ms=latency,
                    timestamp=datetime.now(UTC),
                )
            )
        session.commit()
    finally:
        session.close()

    body = _summary(
        client,
        world,
        "alpha_member",
        "?dimensions=source_label&p95_by=source_label&session_details=true&rank_by=name&rank_order=asc",
    )
    rows = {row["key"]: row for row in body["by_source_label"]}
    assert rows["task-1"]["requests"] == 2
    assert rows["task-1"]["p95_latency_ms"] == 200
    assert rows["task-1"]["source"] == "codex"
    # The member's unlabeled requests rank after the named session.
    assert [row["key"] for row in body["by_source_label"]] == ["task-1", None]


def test_the_organization_latency_and_tools_read_only_the_callers_rows(
    client: TestClient, world: _World, db_session_factory: Callable[[], Session]
) -> None:
    """The p95, overall and per group, and the tool spend come from the rows in scope, not the whole workspace."""
    session = db_session_factory()
    try:
        member = str(world.users["alpha_member"])
        tool_meters = {"tools": {"web_search": {"billed": 2, "errors": 0, "unit_rate": 0.01}}}
        for latency, user_id, meters in (
            (100, member, None),
            (200, member, None),
            # Someone else's requests in the same workspace: slower, and running a tool.
            (90_000, None, tool_meters),
            (90_000, None, tool_meters),
            (90_000, None, tool_meters),
        ):
            session.add(
                UsageLog(
                    id=str(uuid.uuid4()),
                    workspace_id=world.workspaces["alpha_one"],
                    user_id=user_id,
                    model="alpha-one-member",
                    provider="p",
                    endpoint="/v1/chat/completions",
                    source="gateway",
                    status="success",
                    latency_ms=latency,
                    billing_meters=meters,
                    timestamp=datetime.now(UTC),
                )
            )
        session.commit()
    finally:
        session.close()

    base = f"{API_ROOT}/organizations/me/usage"
    code, overall = _as(client, world, "alpha_member", f"{base}/latency")
    assert code == status.HTTP_200_OK, overall
    assert isinstance(overall, dict)
    assert overall["p95_latency_ms"] == 200
    code, grouped = _as(client, world, "alpha_member", f"{base}/latency?group_by=model")
    assert code == status.HTTP_200_OK, grouped
    assert isinstance(grouped, dict)
    assert {group["key"]: group["p95_latency_ms"] for group in grouped["groups"]} == {"alpha-one-member": 200}
    code, tools = _as(client, world, "alpha_member", f"{base}/tools")
    assert code == status.HTTP_200_OK, tools
    assert isinstance(tools, dict)
    assert tools["tools"] == []
    # The owner manages the workspace, so the same reads include everyone's rows.
    code, owner_tools = _as(client, world, "alpha_owner", f"{base}/tools")
    assert code == status.HTTP_200_OK, owner_tools
    assert isinstance(owner_tools, dict)
    assert [(row["tool"], row["calls"]) for row in owner_tools["tools"]] == [("web_search", 6)]


def test_the_deployment_wide_latency_and_tools_refuse_a_tenant(client: TestClient, world: _World) -> None:
    """Like the deployment-wide summary, they read every tenant's rows, so only an operator reaches them."""
    for path in ("latency", "tools"):
        code, _ = _as(client, world, "alpha_owner", f"{API_ROOT}/usage/{path}")
        assert code == status.HTTP_403_FORBIDDEN, path


# =============================================================================
# Workspace totals for members
# =============================================================================

_USAGE = f"{API_ROOT}/organizations/me/usage"


def _visibility(world: _World, workspace: str) -> str:
    return f"{API_ROOT}/workspaces/{world.workspaces[workspace]}/visibility"


def _patch_as(client: TestClient, world: _World, who: str, path: str, body: dict[str, object]) -> tuple[int, object]:
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions[who])
    try:
        response = client.patch(path, json=body)
        return response.status_code, response.json()
    finally:
        client.cookies.clear()


def _set_alpha_one(client: TestClient, world: _World, *, shared: bool) -> None:
    code, body = _patch_as(
        client, world, "alpha_owner", _visibility(world, "alpha_one"), {"members_see_workspace_totals": shared}
    )
    assert code == status.HTTP_200_OK, body


def _share_alpha_one(client: TestClient, world: _World) -> None:
    _set_alpha_one(client, world, shared=True)


def _hide_alpha_one(client: TestClient, world: _World) -> None:
    _set_alpha_one(client, world, shared=False)


def _totals(world: _World, workspace: str = "alpha_one") -> str:
    return f"workspace_id={world.workspaces[workspace]}&workspace_totals=true"


@pytest.mark.parametrize("who", ["alpha_member", "alpha_viewer", "alpha_ws_admin", "alpha_owner"])
def test_every_member_reads_that_a_workspace_keeps_its_totals_by_default(
    client: TestClient, world: _World, who: str
) -> None:
    assert _as(client, world, who, _visibility(world, "alpha_one")) == (
        status.HTTP_200_OK,
        {"members_see_workspace_totals": False, "members_create_policies": True},
    )


def test_a_member_cannot_ask_for_the_totals_until_a_manager_shares_them(client: TestClient, world: _World) -> None:
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/summary?dimensions=model&{_totals(world)}")
    assert code == status.HTTP_403_FORBIDDEN, body
    _share_alpha_one(client, world)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/summary?dimensions=model&{_totals(world)}")
    assert code == status.HTTP_200_OK, body


@pytest.mark.parametrize("who", ["alpha_member", "alpha_viewer"])
def test_a_member_cannot_change_what_the_workspace_shares(client: TestClient, world: _World, who: str) -> None:
    code, _ = _patch_as(client, world, who, _visibility(world, "alpha_one"), {"members_see_workspace_totals": True})
    assert code == status.HTTP_403_FORBIDDEN
    assert _as(client, world, who, _visibility(world, "alpha_one"))[1] == {
        "members_see_workspace_totals": False,
        "members_create_policies": True,
    }


def test_managing_one_workspace_does_not_change_what_another_shares(client: TestClient, world: _World) -> None:
    # Administers Alpha one, and is a plain member of Alpha two.
    path = _visibility(world, "alpha_two")
    code, _ = _patch_as(client, world, "alpha_ws_admin", path, {"members_see_workspace_totals": True})
    assert code == status.HTTP_403_FORBIDDEN
    assert _as(client, world, "alpha_ws_admin", path)[1] == {
        "members_see_workspace_totals": False,
        "members_create_policies": True,
    }


@pytest.mark.parametrize("who", ["alpha_ws_admin", "alpha_owner", "alpha_admin"])
def test_a_manager_changes_what_the_workspace_shares(client: TestClient, world: _World, who: str) -> None:
    code, body = _patch_as(client, world, who, _visibility(world, "alpha_one"), {"members_see_workspace_totals": True})
    assert (code, body) == (
        status.HTTP_200_OK,
        {"members_see_workspace_totals": True, "members_create_policies": True},
    )
    assert _as(client, world, "alpha_member", _visibility(world, "alpha_one"))[1] == {
        "members_see_workspace_totals": True,
        "members_create_policies": True,
    }


@pytest.mark.parametrize(
    ("who", "workspace"),
    [
        ("beta_owner", "alpha_one"),
        ("alpha_member", "alpha_two"),
        ("alpha_newcomer", "alpha_one"),
    ],
)
def test_the_setting_of_a_workspace_the_caller_cannot_see_is_not_found(
    client: TestClient, world: _World, who: str, workspace: str
) -> None:
    assert _as(client, world, who, _visibility(world, workspace))[0] == status.HTTP_404_NOT_FOUND
    code, _ = _patch_as(client, world, who, _visibility(world, workspace), {"members_see_workspace_totals": False})
    assert code == status.HTTP_404_NOT_FOUND


@pytest.mark.parametrize("who", ["alpha_member", "alpha_viewer"])
def test_a_member_who_asks_reads_the_workspaces_totals(client: TestClient, world: _World, who: str) -> None:
    _share_alpha_one(client, world)
    body = _summary(client, world, who, f"?{_totals(world)}")
    assert body["totals"]["request_count"] == len(_ALPHA_ONE_EVERYONE)  # type: ignore[call-overload]
    assert {row["key"] for row in body["by_model"]} == set(_ALPHA_ONE_EVERYONE)
    # Left to the default, the breakdowns are the ones a member may read, and none names a person.
    assert body["by_user"] == []
    assert body["by_api_key"] == []
    assert body["by_source_label"] == []
    assert {row["key"] for row in body["by_provider"]} == {"p"}


@pytest.mark.parametrize("group_by", ["model", "provider"])
def test_a_member_who_asks_reads_the_workspaces_series(client: TestClient, world: _World, group_by: str) -> None:
    _share_alpha_one(client, world)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/series?group_by={group_by}&{_totals(world)}")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert sum(group["requests"] for group in body["groups"]) == len(_ALPHA_ONE_EVERYONE)


@pytest.mark.parametrize("group_by", ["", "&group_by=model", "&group_by=provider"])
def test_a_member_who_asks_reads_the_workspaces_latency(client: TestClient, world: _World, group_by: str) -> None:
    _share_alpha_one(client, world)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/latency?{_totals(world)}{group_by}")
    assert code == status.HTTP_200_OK, body


def test_a_member_who_asks_reads_the_workspaces_groups_by_model(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/groups?group_by=model&{_totals(world)}")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert {group["key"] for group in body["groups"]} == set(_ALPHA_ONE_EVERYONE)


@pytest.mark.parametrize(
    "path",
    [
        "/groups?group_by=api_key",
        "/groups?group_by=user",
        "/groups?group_by=source_label",
        "/groups?group_by=policy",
        "/series?group_by=user_id",
        "/series?group_by=api_key_id",
        "/series?group_by=source",
        "/summary?dimensions=user",
        "/summary?dimensions=model&dimensions=api_key",
        "/summary?dimensions=source_label",
        "/summary?dimensions=none&p95_by=user",
        "/latency?group_by=user",
        "/latency?group_by=api_key",
        "/latency?group_by=model&user_id={member}",
        # Tools are not a breakdown a member may read, so the tools read is refused whole.
        "/tools?model=gpt-4",
        "/summary?user_id={member}",
        "/summary?exclude_user_id={member}",
        "/summary?api_key_id=sk-anything",
        "/series?group_by=model&source_label=session-1",
        "/groups?group_by=model&q=alpha",
        "/summary?source=claude_code",
        "/summary?exclude_source=gateway",
        "/summary?channel=api",
        "/summary?exclude_channel=api",
        "/summary?is_null=api_key_id",
        "/summary?policy_name=fallback",
        "/summary?cost_gt=1",
        "/summary?endpoint=/v1/playground/chat/completions",
        "/series?group_by=model&counts_toward_budget=false",
        "/summary?dimensions=model&group_by_tag=team",
        "/summary?tag=team:alpha",
        # Sent empty is still sent: a filter on the empty source names a source.
        "/summary?source=",
        "/summary?source_label=",
        "/series?group_by=model&source=",
    ],
)
def test_a_member_cannot_split_or_filter_the_totals_by_a_person_key_or_session(
    client: TestClient, world: _World, path: str
) -> None:
    _share_alpha_one(client, world)
    path = path.format(member=world.users["alpha_ws_admin"])
    code, body = _as(client, world, "alpha_member", f"{_USAGE}{path}&{_totals(world)}")
    assert code == status.HTTP_403_FORBIDDEN, body
    assert isinstance(body, dict)
    assert body["detail"].startswith("Workspace totals are not shared with members by `")


def test_a_refusal_names_the_parameter_refused(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/groups?group_by=model&q=alpha&{_totals(world)}")
    assert (code, body) == (
        status.HTTP_403_FORBIDDEN,
        {"detail": "Workspace totals are not shared with members by `q`"},
    )


def test_a_member_splits_the_totals_by_status_code(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/summary?dimensions=status_code&{_totals(world)}")
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert body["totals"]["request_count"] == len(_ALPHA_ONE_EVERYONE)
    assert body["by_model"] == []


def test_a_patch_without_a_field_changes_nothing(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    code, body = _patch_as(client, world, "alpha_owner", _visibility(world, "alpha_one"), {})
    assert (code, body) == (
        status.HTTP_200_OK,
        {"members_see_workspace_totals": True, "members_create_policies": True},
    )


@pytest.mark.parametrize("body", [{"members_see_workspace_totals": None}, {"members_see_workspace_total": False}])
def test_a_patch_that_would_change_nothing_by_mistake_is_refused(
    client: TestClient, world: _World, body: dict[str, object]
) -> None:
    _share_alpha_one(client, world)
    code, _ = _patch_as(client, world, "alpha_owner", _visibility(world, "alpha_one"), body)
    assert code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert _as(client, world, "alpha_member", _visibility(world, "alpha_one"))[1] == {
        "members_see_workspace_totals": True,
        "members_create_policies": True,
    }


def test_a_member_may_narrow_the_totals_by_window_model_and_outcome(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    query = "/summary?model=gpt-4&provider=openai&status=success&start_date=2020-01-01T00:00:00Z"
    code, body = _as(client, world, "alpha_member", f"{_USAGE}{query}&{_totals(world)}")
    assert code == status.HTTP_200_OK, body


def test_the_rows_and_their_count_stay_a_members_own_whatever_they_ask(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    assert _models_listed(client, world, "alpha_member", f"?{_totals(world)}") == set(_ALPHA_ONE_MEMBER_MODELS)
    code, body = _as(client, world, "alpha_member", f"{_USAGE}/count?{_totals(world)}")
    assert (code, body) == (status.HTTP_200_OK, {"total": len(_ALPHA_ONE_MEMBER_MODELS)})


def test_without_asking_a_member_still_reads_their_own(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    query = f"?workspace_id={world.workspaces['alpha_one']}"
    body = _summary(client, world, "alpha_member", query)
    assert body["totals"]["request_count"] == len(_ALPHA_ONE_MEMBER_MODELS)  # type: ignore[call-overload]
    code, groups = _as(
        client, world, "alpha_member", f"{_USAGE}/groups?group_by=user&workspace_id={world.workspaces['alpha_one']}"
    )
    assert code == status.HTTP_200_OK, groups
    assert isinstance(groups, dict)
    assert [group["key"] for group in groups["groups"]] == [str(world.users["alpha_member"])]


@pytest.mark.parametrize(
    "path",
    ["/summary?dimensions=model", "/latency?group_by=model", "/series?group_by=model", "/groups?group_by=model"],
)
def test_asking_for_the_totals_of_a_workspace_that_hides_them_is_refused(
    client: TestClient, world: _World, path: str
) -> None:
    _hide_alpha_one(client, world)

    code, body = _as(client, world, "alpha_member", f"{_USAGE}{path}&{_totals(world)}")

    assert code == status.HTTP_403_FORBIDDEN, body
    assert _models_summarized(client, world, "alpha_member", f"?workspace_id={world.workspaces['alpha_one']}") == set(
        _ALPHA_ONE_MEMBER_MODELS
    )


@pytest.mark.parametrize("hidden", [False, True])
def test_asking_changes_nothing_for_a_manager(client: TestClient, world: _World, hidden: bool) -> None:
    _set_alpha_one(client, world, shared=not hidden)
    for who in ("alpha_ws_admin", "alpha_owner"):
        code, body = _as(client, world, who, f"{_USAGE}/groups?group_by=user&{_totals(world)}")
        assert code == status.HTTP_200_OK, body
        assert isinstance(body, dict)
        assert sum(group["requests"] for group in body["groups"]) == len(_ALPHA_ONE_EVERYONE), who
        summary = _summary(client, world, who, f"?{_totals(world)}")
        assert {row["key"] for row in summary["by_user"]} >= {str(world.users["alpha_member"])}


@pytest.mark.parametrize("workspace", ["beta_one", "alpha_two"])
def test_a_member_cannot_ask_for_the_totals_of_a_workspace_they_do_not_belong_to(
    client: TestClient, world: _World, workspace: str
) -> None:
    _share_alpha_one(client, world)
    for path in (
        "/summary?dimensions=model",
        "/latency?group_by=model",
        "/tools?model=gpt-4",
        "/series?group_by=model",
        "/groups?group_by=model",
    ):
        code, _ = _as(client, world, "alpha_member", f"{_USAGE}{path}&{_totals(world, workspace)}")
        assert code == status.HTTP_404_NOT_FOUND, path


def test_asking_for_totals_without_naming_a_workspace_is_refused(client: TestClient, world: _World) -> None:
    _share_alpha_one(client, world)
    code, _ = _as(client, world, "alpha_member", f"{_USAGE}/summary?workspace_totals=true")
    assert code == status.HTTP_422_UNPROCESSABLE_CONTENT


def _post_as(client: TestClient, world: _World, who: str, path: str, body: dict[str, object]) -> dict[str, object]:
    client.cookies.set(SESSION_COOKIE_NAME, world.sessions[who])
    try:
        response = client.post(path, json=body)
        assert response.status_code == status.HTTP_201_CREATED, response.text
        created: dict[str, object] = response.json()
        return created
    finally:
        client.cookies.clear()


@pytest.mark.parametrize("shared", [False, True])
def test_a_member_reads_the_workspace_budget_in_dollars_only_while_it_shares_its_totals(
    client: TestClient, world: _World, shared: bool
) -> None:
    organizations = f"{API_ROOT}/organizations/me"
    budget = _post_as(
        client,
        world,
        "alpha_owner",
        f"{organizations}/budgets",
        {"name": "Alpha one", "max_budget": 250.0, "reset_alignment": "calendar_month"},
    )
    _post_as(
        client,
        world,
        "alpha_owner",
        f"{organizations}/spend-ceilings",
        {"scope_type": "workspace", "scope_id": str(world.workspaces["alpha_one"]), "budget_id": budget["budget_id"]},
    )
    _set_alpha_one(client, world, shared=shared)
    path = f"{API_ROOT}/workspaces/{world.workspaces['alpha_one']}/budget"

    code, member = _as(client, world, "alpha_member", path)
    _, owner = _as(client, world, "alpha_owner", path)

    assert code == status.HTTP_200_OK, member
    assert isinstance(member, dict) and isinstance(owner, dict)
    assert member["max_budget"] == 250.0
    assert member["spent"] == (owner["spent"] if shared else None)
    assert owner["spent"] is not None


@pytest.mark.parametrize(("shared", "scope"), [(False, "you"), (True, "workspace")])
def test_a_members_overview_reads_the_workspace_only_while_it_shares_its_totals(
    client: TestClient, world: _World, shared: bool, scope: str
) -> None:
    _set_alpha_one(client, world, shared=shared)
    code, body = _as(
        client,
        world,
        "alpha_member",
        f"{API_ROOT}/overview?scope=workspace&workspace_id={world.workspaces['alpha_one']}",
    )
    assert code == status.HTTP_200_OK, body
    assert isinstance(body, dict)
    assert body["scope"] == scope
    assert body["visibility"] == {"members_see_workspace_totals": shared, "members_create_policies": True}
