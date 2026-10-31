"""The routing configuration of the caller's own organization, for a tenant.

``/api/v1/routing/policies`` and ``/api/v1/aliases`` are deployment-wide and
operator-only, which is right: they list every tenant's stored rows and take a
``workspace_id`` the client supplies, so nothing but the operator gate stands
between a signed-in member and another organization's routing (the escalation
otari-ai#1880 closed). These routers are a second, narrower reading and writing
of the same tables, shaped like ``organization_usage.py``
(mozilla-ai/otari#837), giving the roles matrix what it asks for: View for a
member, Edit for an admin (otari-ai#1942, otari-ai#1969).

* **Scope is derived, never accepted.** The organization comes from the caller's
  own ``active_organization_id`` by way of ``resolve_visible_workspace_scope``,
  which refuses a pointer with no live membership behind it. No request here
  names an organization.
* **How much of it a read covers** follows the rule the workspace list uses: an
  owner or an admin reads every workspace in the organization, and
  a member or viewer reads the ones they actively belong to. A member who
  belongs to no workspace still gets the config-file entries, which are
  deployment-wide and in force in every workspace they could ever join.
* **Both reads are bounded.** ``limit`` caps the stored rows a request
  materializes, and the config-file entries are appended within the same cap, so
  neither response grows with the tenant. The default is the cap rather than a
  page, because the dashboard renders policies and aliases as one sorted table
  and a page of one beside every row of the other would be incoherent; the bound
  is there for the organization that outgrows the page, not to paginate the page.
* **A policy may be one member's, named by identity, never by billing id.** A
  stored policy may be scoped to one ``users.user_id`` as well as to a workspace.
  ``user_id`` stays refused here, because it is a deployment-wide identifier and
  accepting one would make this an existence oracle across tenants. A policy
  write names ``member_id`` instead: an identity of the caller's own
  organization, whose attribution id (its UUID as a string) is the scope. A
  member names only themselves, and only while the workspace lets members
  create policies (``members_create_policies``); one they already have stays
  theirs to edit and delete either way. An owner or admin names anyone active in
  the organization who may see the workspace. Policy reads show an owner or
  admin every member's, and a member their own, beside the workspace-wide ones.
  Aliases stay workspace-wide, on the reads as much as the writes.
* **A write needs a named workspace, resolved inside the organization.** There is
  no default-workspace fallback here, unlike the operator routers: the
  deployment's default workspace is not the tenant's to write into unless it
  happens to be one of theirs, and a silent fallback is how it would become one.

Aliases and policies did not need an owner column for any of this. Both tables
already carry a non-nullable ``workspace_id``, and a workspace belongs to exactly
one organization, so the row's tenant is a join away. That is why this follows
mozilla-ai/otari#875's shape (a ``/api/v1/organizations/me/*`` router over the same
rows) without following its migration.

**What stops a tenant widening their own access.** A policy or an alias decides
which real model a name reaches, so an unconstrained write is a way to name a
model the tenant may not call. Every target here is put through the same
allow-list the catalog is filtered by
(``services/tenancy/organization_model_access``), so an admin can only point a
name at something their organization already reaches. That check, not the
operator gate, is what makes these writes safe to open.

``fallbacks_router`` is a read in the same scope: the models the organization's
traffic used, and the fallback a catalog ID gives each with no policy.
"""

import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import Select, false, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col

from gateway.api.deps import (
    CurrentIdentity,
    RequestSessionModelProviderPortDep,
    RoutingServiceDep,
    VisibleWorkspacesDep,
    get_config,
    get_db,
    verify_master_key,
)
from gateway.api.routes.aliases import (
    AliasRequest,
    AliasResponse,
    delete_alias_in_workspace,
    upsert_alias_in_workspace,
)
from gateway.api.routes.routing import (
    PolicyRequest,
    PolicyResponse,
    delete_policy_in_workspace,
    upsert_policy_in_workspace,
    validated_spec,
)
from gateway.core.config import GatewayConfig
from gateway.log_config import logger
from gateway.models.providers import ModelAlias
from gateway.models.routing import PolicySpec, RoutingPolicy
from gateway.models.tenancy import MANAGEMENT_ROLES, Organization, Workspace
from gateway.models.tenancy import User as TenancyUser
from gateway.ports.model_provider_port import ModelProviderPort
from gateway.repositories.tenancy.organization_member_repository import OrganizationMemberRepository
from gateway.repositories.users_repository import get_or_create_live_attribution_user
from gateway.schemas.routing import AutomaticFallbackPublic, AutomaticFallbacksResponse
from gateway.services.alias_service import all_alias_names
from gateway.services.model_access import is_model_allowed
from gateway.services.policy_store import all_policy_names
from gateway.services.provider_kwargs import normalize_pricing_key
from gateway.services.routing import FALLBACK_WINDOW
from gateway.services.tenancy import OrganizationService
from gateway.services.tenancy.authorization import (
    VisibleWorkspaceScope,
    resolve_visible_workspace_scope,
    resolve_workspace_in_organization,
)
from gateway.services.tenancy.organization_model_access import resolve_session_model_allowlist

# Authentication only, like the rest of the ``/api/v1/organizations/me`` surface.
# What the caller may read or write is decided per request below, which is the
# pattern the tenant-scoped routers already follow and the reason the deployment
# operator gate does not belong here.
policies_router = APIRouter(
    prefix="/organizations/me/routing-policies",
    tags=["routing"],
    dependencies=[Depends(verify_master_key)],
)

aliases_router = APIRouter(
    prefix="/organizations/me/aliases",
    tags=["aliases"],
    dependencies=[Depends(verify_master_key)],
)

fallbacks_router = APIRouter(
    prefix="/organizations/me/automatic-fallbacks",
    tags=["routing"],
    dependencies=[Depends(verify_master_key)],
)

# The cap on either list, and its default. High enough that no real organization's
# routing configuration is truncated by it, low enough that one row per name is
# never an unbounded read.
_MAX_ROWS = 1000


async def _writable_workspace_id(
    db: AsyncSession,
    config: GatewayConfig,
    *,
    user: TenancyUser,
    workspace_id: uuid.UUID | None,
    targets: list[str],
    model_provider: ModelProviderPort | None,
) -> uuid.UUID:
    """Resolve the workspace a tenant write lands in, refusing what it may not do.

    Three refusals, in the order that keeps each one from leaking what the next
    would have told the caller. Management access first, so a member learns
    nothing about which workspaces exist. Then the workspace, resolved inside the
    caller's own organization, so another tenant's id is a 404 rather than a 403.
    Then the targets, against the organization's own reach.
    """
    organizations = OrganizationService(db, membership_listener=None)
    organization = await organizations.get_active_organization_for_user(user)
    await organizations.require_active_organization_management_access(user=user, organization=organization)
    if workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="workspace_id is required: an organization's routing entries belong to one of its workspaces.",
        )
    workspace = await resolve_workspace_in_organization(
        db,
        user=user,
        workspace_id=workspace_id,
        organization=organization,
        organizations=organizations,
    )
    await _require_reachable_targets(db, config, user=user, targets=targets, model_provider=model_provider)
    return workspace.id


async def _require_reachable_targets(
    db: AsyncSession,
    config: GatewayConfig,
    *,
    user: TenancyUser,
    targets: list[str],
    model_provider: ModelProviderPort | None,
) -> None:
    """Refuse a target the caller's organization cannot already reach.

    Without this, writing a policy would be a way to reach a provider the
    organization holds no key for: the name is the tenant's to choose, and
    resolution follows the name. Answered as a 400 naming the target, because it
    is a statement about the body rather than about the caller's role.

    A target that names another alias or policy is left alone, because the write
    helpers refuse chaining a step later and say so precisely. Checking it here
    first would answer "not available to this organization", which is true of an
    indirection name and useless for fixing it.
    """
    if not targets:
        return
    indirections = all_alias_names(config) | all_policy_names(config)
    allowlist = await resolve_session_model_allowlist(db, config, user=user, model_provider=model_provider)
    unreachable = [
        target
        for target in targets
        if target not in indirections and not is_model_allowed(allowlist, normalize_pricing_key(config, target))
    ]
    if unreachable:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Target(s) {', '.join(sorted(unreachable))} are not available to this organization. "
                "Add a provider key for them first, or pick a model from the catalog."
            ),
        )


class OrganizationPolicyRequest(PolicyRequest):
    """A tenant policy write: the operator's body, scoped to a member by identity rather than ``user_id``."""

    member_id: uuid.UUID | None = Field(
        default=None,
        description=(
            "Scope the policy to one member, by identity id: it applies only to requests made with their keys, "
            "and wins over a workspace-wide or config policy of the same name for them. A member may name only "
            "themselves; an owner or admin may name any active member of the organization who may see the "
            "workspace. Omit for a workspace-wide policy, which only an owner or admin may write. `user_id` is "
            "not accepted here."
        ),
    )
    replaces_alias: bool = Field(
        default=False,
        description=(
            "Turn the workspace's own workspace-wide alias of this name into this policy, in one step, so "
            "callers sending the name never find neither. Owners and admins, workspace-wide policies only."
        ),
    )


class PolicyCopyRequest(BaseModel):
    """Make the caller's own version of a shared policy."""

    name: str = Field(description="The shared policy to copy: a workspace-wide one in the workspace, or config.yml's.")
    workspace_id: uuid.UUID = Field(description="The workspace the copy belongs to, which the caller must see.")


@dataclass(frozen=True)
class _Caller:
    """The caller's organization and whether they manage it."""

    identity: TenancyUser
    organization: Organization
    organizations: OrganizationService
    manages: bool


async def _caller(db: AsyncSession, identity: TenancyUser) -> _Caller:
    """Resolve the caller's active organization and their role in it, read on every request."""
    organizations = OrganizationService(db, membership_listener=None)
    organization = await organizations.get_active_organization_for_user(identity)
    membership = await organizations.members.get_active_by_organization_and_user(organization.id, identity.id)
    return _Caller(
        identity=identity,
        organization=organization,
        organizations=organizations,
        manages=membership is not None and membership.role in MANAGEMENT_ROLES,
    )


def _require_workspace_id(workspace_id: uuid.UUID | None) -> uuid.UUID:
    if workspace_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="workspace_id is required: an organization's routing entries belong to one of its workspaces.",
        )
    return workspace_id


async def _member_policy_scope(
    db: AsyncSession, caller: _Caller, *, workspace_id: uuid.UUID, member_id: uuid.UUID, require_active: bool = True
) -> tuple[Workspace, str]:
    """The workspace and the attribution id a member-scoped policy write or delete acts on, refusing what it may not.

    Naming oneself takes only seeing the workspace. Naming someone else takes
    managing the organization, and that person being an active member of it who
    may see the workspace. With ``require_active`` off, for a delete that cleans
    up after someone who left, any membership of theirs will do, which is the
    set the list shows. Anyone else's id is the 404 an unknown one is, so a row
    the operator scoped to a non-member is never destroyed from here.
    """
    if member_id == caller.identity.id:
        owner = caller.identity
    else:
        if not caller.manages:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Only an organization owner or admin may act on another member's policies.",
            )
        found = await caller.organizations.users.get(member_id)
        is_member = found is not None and await caller.organizations.user_has_active_membership(
            organization_id=caller.organization.id, user_id=found.id
        )
        was_member = is_member or (
            await caller.organizations.members.get_by_organization_and_user(caller.organization.id, member_id)
            is not None
        )
        if not (is_member if require_active else was_member):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No such member in this organization.")
        owner = found if found is not None and is_member else caller.identity
    workspace = await resolve_workspace_in_organization(
        db, user=owner, workspace_id=workspace_id, organization=caller.organization, organizations=caller.organizations
    )
    return workspace, str(member_id)


async def _require_live_owner(db: AsyncSession, user_id: str, alias: str | None) -> None:
    """Make sure the attribution row a member's policy hangs off exists, never reviving one an operator revoked."""
    if await get_or_create_live_attribution_user(db, user_id=user_id, alias=alias) is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That member's spend identity has been deactivated on this deployment; ask an operator to "
            "restore it.",
        )


async def _stored_policy_exists(db: AsyncSession, *, workspace_id: uuid.UUID, name: str, user_id: str | None) -> bool:
    statement = select(RoutingPolicy.id).where(
        col(RoutingPolicy.workspace_id) == workspace_id,
        col(RoutingPolicy.name) == name,
        col(RoutingPolicy.user_id) == user_id if user_id is not None else col(RoutingPolicy.user_id).is_(None),
    )
    return (await db.execute(statement.limit(1))).scalar_one_or_none() is not None


def _require_members_create(caller: _Caller, workspace: Workspace) -> None:
    """Refuse a member creating a policy of their own where the workspace's managers turned that off."""
    if not caller.manages and not workspace.members_create_policies:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This workspace's admins have turned off creating your own policies. The ones you have still "
            "apply, and you can edit or delete them.",
        )


def _reject_user_scope(user_id: str | None) -> None:
    """Refuse a user-scoped entry on the tenant surface.

    A user-scoped row names a ``users.user_id``, which is a deployment-wide
    identifier with nothing in it saying whose it is, so accepting one would make
    this an existence oracle across tenants. The operator router keeps that scope;
    an organization admin writes workspace-wide, which is what the roles matrix
    asks of them.
    """
    if user_id is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="user_id is not accepted here: an organization's entries are workspace-wide.",
        )


def _visible_workspace_ids(scope: VisibleWorkspaceScope) -> Select[tuple[uuid.UUID]]:
    """The workspace ids whose stored rows this caller may be shown.

    A subquery rather than a clause over one table, so the policies list and the
    aliases list express one rule over their two. An owner or admin is a
    predicate over ``organization_id`` rather than an ``IN`` list, so it does not
    grow with the tenant.
    """
    statement = select(col(Workspace.id))
    if scope.sees_every_workspace:
        return statement.where(col(Workspace.organization_id) == scope.organization.id)
    if scope.workspace_ids:
        return statement.where(col(Workspace.id).in_(scope.workspace_ids))
    # Belongs to no workspace yet: no stored row is theirs to see, and
    # deliberately not a 403 (nothing was refused). The config entries below are
    # deployment-wide, so they are still listed.
    return statement.where(false())


_LIMIT = Query(ge=1, le=_MAX_ROWS, description="Maximum entries to return, stored and config-file together.")

_WORKSPACE_FILTER = Query(
    description=(
        "Only stored entries in this workspace. Config-file entries are always included, being "
        "deployment-wide. Omit for every workspace this caller may see."
    )
)


@policies_router.get("")
async def list_visible_routing_policies(
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    limit: Annotated[int, _LIMIT] = _MAX_ROWS,
    workspace_id: Annotated[uuid.UUID | None, _WORKSPACE_FILTER] = None,
) -> list[PolicyResponse]:
    """List the routing policies in force in the workspaces this caller may see.

    Stored policies from the caller's visible workspaces plus the config-file
    policies, which are deployment-wide and resolve in every workspace. The
    response is the shape ``GET /api/v1/routing/policies`` answers, narrowed to the
    caller's own organization, and narrowed again to one workspace when
    ``workspace_id`` names one. Beside the workspace-wide policies, an owner or
    admin sees every member's own, and anyone else their own alone; ``user_id``
    on such a row is the member's identity id.
    """
    scope = await resolve_visible_workspace_scope(
        db,
        user=current_identity,
        organizations=OrganizationService(db, membership_listener=None),
    )
    # A person's row is listed only when the person is a member's identity: to an
    # owner or admin anyone's who ever belonged to the organization, to anyone
    # else their own. A row the operator scoped to some other user stays the
    # operator's, since nothing here could address it.
    people = (
        OrganizationMemberRepository.attribution_ids(scope.organization.id)
        if scope.sees_every_workspace
        else select(literal(str(current_identity.id)))
    )
    statement = select(RoutingPolicy).where(
        col(RoutingPolicy.workspace_id).in_(_visible_workspace_ids(scope)),
        or_(col(RoutingPolicy.user_id).is_(None), col(RoutingPolicy.user_id).in_(people)),
    )
    if workspace_id is not None:
        statement = statement.where(col(RoutingPolicy.workspace_id) == workspace_id)
    rows = (await db.execute(statement.order_by(RoutingPolicy.name).limit(limit))).scalars().all()
    policies = []
    for row in rows:
        try:
            parsed = PolicySpec.model_validate(row.spec)
        except ValidationError:
            # Listed rather than hidden, matching the operator view: hiding a row
            # this build cannot parse would make the dashboard disagree with what
            # actually resolves.
            logger.warning("Stored routing policy %r does not validate; listing it as-is", row.name)
            policies.append(PolicyResponse.from_model(row, is_dynamic=False))
            continue
        policies.append(PolicyResponse.from_model(row, is_dynamic=parsed.is_dynamic))
    # Config last, matching the operator list: deployment-wide, in force in every
    # workspace, listed once and unscoped.
    for name, spec in config.routing.policies.items():
        if len(policies) >= limit:
            break
        policies.append(
            PolicyResponse(
                name=name,
                spec=spec.model_dump(mode="json", exclude_none=True),
                source="config",
                is_dynamic=spec.is_dynamic,
            )
        )
    return sorted(policies, key=lambda policy: (policy.name, str(policy.workspace_id or ""), policy.user_id or ""))


@policies_router.post("")
async def set_organization_routing_policy(
    request: OrganizationPolicyRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    model_provider: RequestSessionModelProviderPortDep,
) -> PolicyResponse:
    """Create or update a stored policy in one of the organization's workspaces.

    ``workspace_id`` is required and must name a workspace of the caller's own
    organization; ``user_id`` is not accepted here. A workspace-wide policy is an
    owner's or admin's to write. With ``member_id`` the policy is that member's
    own: a member may write their own (creating one only while the workspace lets
    members create policies), and an owner or admin anyone's.
    """
    _reject_user_scope(request.user_id)
    targets = validated_spec(request.name, request.spec).static_selectors()
    if request.member_id is None:
        workspace_id = await _writable_workspace_id(
            db,
            config,
            user=current_identity,
            workspace_id=request.workspace_id,
            targets=targets,
            model_provider=model_provider,
        )
        body = PolicyRequest(**request.model_dump(include=set(PolicyRequest.model_fields)))
        return await upsert_policy_in_workspace(
            body, db, config, workspace_id=workspace_id, replacing_alias=request.replaces_alias
        )
    if request.replaces_alias:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="replaces_alias turns a workspace-wide alias into a workspace-wide policy; leave member_id out.",
        )
    caller = await _caller(db, current_identity)
    workspace, user_id = await _member_policy_scope(
        db, caller, workspace_id=_require_workspace_id(request.workspace_id), member_id=request.member_id
    )
    lookup = request.rename_from if request.rename_from is not None else request.name
    if not await _stored_policy_exists(db, workspace_id=workspace.id, name=lookup, user_id=user_id):
        _require_members_create(caller, workspace)
    await _require_reachable_targets(db, config, user=current_identity, targets=targets, model_provider=model_provider)
    await _require_live_owner(db, user_id, None)
    body = PolicyRequest(
        name=request.name,
        spec=request.spec,
        user_id=user_id,
        workspace_id=workspace.id,
        rename_from=request.rename_from,
    )
    return await upsert_policy_in_workspace(body, db, config, workspace_id=workspace.id)


@policies_router.post("/copy")
async def copy_organization_routing_policy(
    request: PolicyCopyRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    model_provider: RequestSessionModelProviderPortDep,
) -> PolicyResponse:
    """Make the caller's own version of a shared policy: the same name and spec, applying only to their requests.

    The source is the workspace's workspace-wide policy of that name, else the
    config.yml one. The copy wins over it for the caller alone, and deleting the
    copy hands their requests back to it. Creating one follows the workspace's
    ``members_create_policies`` like any other policy of a member's own; having
    one already is a 409.
    """
    caller = await _caller(db, current_identity)
    workspace, user_id = await _member_policy_scope(
        db, caller, workspace_id=request.workspace_id, member_id=current_identity.id
    )
    stored = (
        await db.execute(
            select(RoutingPolicy).where(
                col(RoutingPolicy.workspace_id) == workspace.id,
                col(RoutingPolicy.name) == request.name,
                col(RoutingPolicy.user_id).is_(None),
            )
        )
    ).scalar_one_or_none()
    if stored is not None:
        spec = stored.spec
    elif request.name in config.routing.policies:
        spec = config.routing.policies[request.name].model_dump(mode="json", exclude_none=True)
    else:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No shared policy named '{request.name}' in this workspace.",
        )
    if await _stored_policy_exists(db, workspace_id=workspace.id, name=request.name, user_id=user_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"You already have your own version of '{request.name}'.",
        )
    _require_members_create(caller, workspace)
    targets = validated_spec(request.name, spec).static_selectors()
    await _require_reachable_targets(db, config, user=current_identity, targets=targets, model_provider=model_provider)
    await _require_live_owner(db, user_id, current_identity.full_name or current_identity.email)
    body = PolicyRequest(name=request.name, spec=spec, user_id=user_id, workspace_id=workspace.id)
    return await upsert_policy_in_workspace(body, db, config, workspace_id=workspace.id)


@policies_router.delete("/{name:path}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_organization_routing_policy(
    name: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    workspace_id: Annotated[
        uuid.UUID | None,
        Query(description="Delete the policy in this workspace of the caller's organization."),
    ] = None,
    member_id: Annotated[
        uuid.UUID | None,
        Query(
            description="Delete this member's own policy rather than the workspace-wide one. A member may name "
            "only themselves; an owner or admin anyone, including someone who has since left."
        ),
    ] = None,
) -> None:
    """Delete a stored policy from one of the organization's workspaces.

    A workspace-wide policy is an owner's or admin's to delete. A member deletes
    their own, whatever ``members_create_policies`` says, and an owner or admin
    anyone's.
    """
    if member_id is None:
        resolved = await _writable_workspace_id(
            db,
            config,
            user=current_identity,
            workspace_id=workspace_id,
            targets=[],
            model_provider=None,
        )
        await delete_policy_in_workspace(name, db, config, workspace_id=resolved, user_id=None)
        return
    caller = await _caller(db, current_identity)
    workspace, user_id = await _member_policy_scope(
        db, caller, workspace_id=_require_workspace_id(workspace_id), member_id=member_id, require_active=False
    )
    await delete_policy_in_workspace(name, db, config, workspace_id=workspace.id, user_id=user_id)


@aliases_router.get("")
async def list_visible_aliases(
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    limit: Annotated[int, _LIMIT] = _MAX_ROWS,
    workspace_id: Annotated[uuid.UUID | None, _WORKSPACE_FILTER] = None,
) -> list[AliasResponse]:
    """List the aliases in force in the workspaces this caller may see.

    The policies list's sibling, over ``model_aliases``, and scoped the same way:
    stored rows from the caller's visible workspaces, plus the config-file
    aliases, which are deployment-wide, and narrowed to one workspace when
    ``workspace_id`` names one.
    """
    scope = await resolve_visible_workspace_scope(
        db,
        user=current_identity,
        organizations=OrganizationService(db, membership_listener=None),
    )
    statement = select(ModelAlias).where(
        col(ModelAlias.workspace_id).in_(_visible_workspace_ids(scope)),
        col(ModelAlias.user_id).is_(None),
    )
    if workspace_id is not None:
        statement = statement.where(col(ModelAlias.workspace_id) == workspace_id)
    rows = (await db.execute(statement.order_by(ModelAlias.name).limit(limit))).scalars().all()
    aliases = [AliasResponse.from_model(row) for row in rows]
    for name, target in config.aliases.items():
        if len(aliases) >= limit:
            break
        aliases.append(AliasResponse(name=name, target=target, source="config"))
    return sorted(aliases, key=lambda alias: (alias.name, str(alias.workspace_id or ""), alias.user_id or ""))


@aliases_router.post("")
async def set_organization_alias(
    request: AliasRequest,
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    model_provider: RequestSessionModelProviderPortDep,
) -> AliasResponse:
    """Create or update a stored alias in one of the organization's workspaces.

    Organization owners and admins only, with the same two scope rules the policy
    write has: ``workspace_id`` is required and resolved inside the caller's
    organization, and ``user_id`` is not accepted.
    """
    _reject_user_scope(request.user_id)
    workspace_id = await _writable_workspace_id(
        db,
        config,
        user=current_identity,
        workspace_id=request.workspace_id,
        targets=[request.target],
        model_provider=model_provider,
    )
    return await upsert_alias_in_workspace(request, db, config, workspace_id=workspace_id)


@aliases_router.delete("/{name:path}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_organization_alias(
    name: str,
    db: Annotated[AsyncSession, Depends(get_db)],
    config: Annotated[GatewayConfig, Depends(get_config)],
    current_identity: CurrentIdentity,
    workspace_id: Annotated[
        uuid.UUID | None,
        Query(description="Delete the alias in this workspace of the caller's organization."),
    ] = None,
) -> None:
    """Delete a stored alias from one of the organization's workspaces. Owners and admins only."""
    resolved = await _writable_workspace_id(
        db,
        config,
        user=current_identity,
        workspace_id=workspace_id,
        targets=[],
        model_provider=None,
    )
    await delete_alias_in_workspace(name, db, config, workspace_id=resolved, user_id=None)


@fallbacks_router.get("")
async def list_automatic_fallbacks(
    visible: VisibleWorkspacesDep, routing: RoutingServiceDep
) -> AutomaticFallbacksResponse:
    """The models the caller's organization sent requests to in the last 30 days, and the fallback each gets.

    A request that sends a model's catalog ID moves to the model's next offering
    when one fails, with no policy. Each model lists its offerings in the order
    such a request tries them, priced for this organization, with who runs the
    built-in tools on each, beside its traffic: how many requests a backup served,
    and how many named one offering and so had no fallback. The traffic is the
    workspaces the caller may see in their active organization, by the rule the
    organization's usage reads use.
    """
    fallbacks = await routing.automatic_fallbacks(
        organization_id=visible.organization_id, workspace_ids=visible.workspace_ids
    )
    return AutomaticFallbacksResponse(
        window_days=FALLBACK_WINDOW.days,
        models=[AutomaticFallbackPublic.model_validate(fallback) for fallback in fallbacks],
    )
