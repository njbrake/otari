"""The routing domain's service: what callers get from routing, read for one organization."""

import uuid
from collections import Counter, defaultdict
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from gateway.core.config import GatewayConfig
from gateway.core.unit_of_work import UnitOfWork
from gateway.exceptions.organizations_exceptions import WorkspaceNotFoundError
from gateway.repositories.routing import RoutingPolicyRepository
from gateway.services.alias_service import resolve_effective_alias
from gateway.services.api_keys import ApiKeyService, KeyReach
from gateway.services.catalog import catalog_models, offering_input_rate, resolve_catalog_offerings
from gateway.services.model_access import workspace_serves_target
from gateway.services.policy_store import resolve_effective_policy
from gateway.services.routing.compiler import compile_catalog_plan, reachable_candidates
from gateway.services.tenancy import OrganizationService
from gateway.services.tools import provider_tools
from gateway.services.usage_and_telemetry import KeyNameTraffic, ServedTraffic, TrafficReader, UsageService

_ANSWERED = frozenset({"success", "incomplete"})
"""Final statuses whose step answered the request; ``error`` and ``absorbed`` are failures of it."""

FALLBACK_WINDOW = timedelta(days=30)
"""How far back the automatic fallbacks look for traffic."""


@dataclass(frozen=True)
class FallbackOffering:
    """One offering a catalog ID tries, and who runs the built-in tools on it."""

    selector: str
    provider: str
    """The instance the selector names."""
    provider_type: str
    input_price: float | None
    """Per million input tokens at this organization's rates, None where unpriced."""
    own_tools: tuple[str, ...]
    """Built-in tools the provider runs itself."""
    otari_tools: tuple[str, ...]
    """Built-in tools Otari runs in the provider's place."""


@dataclass(frozen=True)
class PinnedTraffic:
    """The requests one API key sent naming a provider or a policy rather than the catalog ID, by provider reached."""

    api_key_id: str | None
    """None for requests made without a key or whose key was deleted."""
    key_name: str | None
    provider: str
    requests: int


@dataclass(frozen=True)
class KeyRequests:
    """How many requests one API key sent."""

    api_key_id: str
    key_name: str | None
    requests: int


TargetRole = Literal["default", "routed", "condition", "on_failure", "catalog", "other"]


def _role_of(selection_reason: str | None) -> tuple[TargetRole, str | None]:
    """A target's role, and its router's name, from the ``selection_reason`` routing recorded."""
    reason = selection_reason or ""
    if reason.startswith("router:"):
        return "routed", reason.partition(":")[2] or None
    if reason.startswith("condition:"):
        return "condition", None
    if reason == "default":
        return "default", None
    if reason == "on_failure":
        return "on_failure", None
    if reason == "catalog":
        return "catalog", None
    return "other", None


_ROLE_ORDER: dict[str, int] = {"routed": 0, "condition": 1, "default": 2, "catalog": 3, "on_failure": 4, "other": 5}


@dataclass(frozen=True)
class StepOutcome:
    """What one target of a plan did in one role: the requests it served, and the attempts on it that failed.

    Grouped by what served rather than by place in the plan, because a place
    names different targets from request to request: a router ranks its pool
    per request, a tier-down swaps the head, and the compiler drops a candidate
    a key may not reach, so position 2 is a backup on one request and the
    router's second pick on another.
    """

    target: str
    """The offering tried, ``provider:model``, or the whole selector an older row carries."""
    role: TargetRole
    router: str | None
    """The router that picked it, when ``role`` is ``routed``."""
    position: int
    """The earliest place in a plan it was tried, 1 for the first."""
    served: int
    failed: int


@dataclass(frozen=True)
class NameTraffic:
    """The traffic sent under one routing name in one workspace."""

    workspace_id: uuid.UUID
    name: str
    requests: int
    sent_by: tuple[KeyRequests, ...]
    """The keys that sent them, most first."""
    steps: tuple[StepOutcome, ...]
    """By earliest place tried, then by role and target."""


def _most_first(counts: Counter[str], names: Mapping[str, str | None]) -> tuple[KeyRequests, ...]:
    return tuple(
        KeyRequests(api_key_id=key, key_name=names.get(key), requests=n)
        for key, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    )


@dataclass(frozen=True)
class AutomaticFallback:
    """One model callers used in the window, its offerings in baseline order, and its traffic."""

    id: str
    name: str
    offerings: tuple[FallbackOffering, ...]
    requests: int
    fell_back: int
    """Of ``requests``, the successful ones a later offering served."""
    pinned: int
    """Of ``requests``, those that did not send the catalog ID and so had no automatic fallback."""
    pinned_provider: str | None
    """The instance most of the pinned requests reached."""
    pinned_keys: tuple[PinnedTraffic, ...]
    """The pinned requests by key and provider, most first."""
    sent_by: tuple[KeyRequests, ...] = ()
    """The keys the reader may see that sent ``requests``, most first."""


KEY_MODELS_SHOWN = 10
"""How many of a key's names its routing read lists; the counts cover them all."""

NameKind = Literal["policy", "alias", "catalog", "pinned", "unknown"]
Backup = Literal["has_backup", "no_backup", "subscription", "unknown"]
NoBackupReason = Literal["single_offering", "single_target_policy", "pinned", "no_allowed_offering"]


@dataclass(frozen=True)
class KeyModel:
    """One name a key sent in the window, and whether a failure on it has somewhere to go."""

    name: str
    requests: int
    kind: NameKind
    """What the name is to this key now: a routing policy, an alias, a catalog ID, a pinned ``provider:model``."""
    backup: Backup
    reason: NoBackupReason | None
    """Why there is no backup; set only when ``backup`` is ``no_backup``."""
    provider: str | None
    """The one instance that serves it, when one alone does."""


@dataclass(frozen=True)
class KeyPolicy:
    """One routing policy a key sent in the window, by name."""

    name: str
    requests: int
    deleted: bool = False
    """No policy of that name is in force for the key now: it was deleted or renamed since."""


@dataclass(frozen=True)
class KeyRouting:
    """What one key sent in the window and what a failure on each name does."""

    api_key_id: str
    models: tuple[KeyModel, ...]
    """The most requested names first, at most ``KEY_MODELS_SHOWN``."""
    model_count: int
    no_backup_count: int
    no_backup: tuple[KeyModel, ...]
    """The names with no backup, most requested first, at most ``KEY_MODELS_SHOWN``; ``no_backup_count`` counts all."""
    policies: tuple[KeyPolicy, ...]
    """Every policy the key sent, most requested first, a deleted one included."""


@dataclass(frozen=True)
class _Coverage:
    kind: NameKind
    backup: Backup
    reason: NoBackupReason | None = None
    provider: str | None = None


def _instance(selector: str) -> str | None:
    """The instance a ``provider:model`` selector names; None for any other spelling, such as a catalog ID."""
    instance, colon, _ = selector.partition(":")
    return instance if colon else None


@dataclass
class _Tally:
    requests: int = 0
    fell_back: int = 0
    pinned: Counter[str] = field(default_factory=Counter)
    pinned_keys: Counter[tuple[str | None, str]] = field(default_factory=Counter)
    keys: Counter[str] = field(default_factory=Counter)


def _served_selectors(row: ServedTraffic) -> tuple[str, ...]:
    """The spellings of the offering a row reached: ``provider:model``, or the whole selector an older row carries."""
    return (f"{row.provider}:{row.model}", row.model) if row.provider else (row.model,)


class RoutingService:
    """What routing gives an organization's callers."""

    def __init__(
        self,
        config: GatewayConfig,
        usage: UsageService,
        keys: ApiKeyService,
        *,
        uow: UnitOfWork,
        organizations: OrganizationService,
    ) -> None:
        self._config = config
        self._usage = usage
        self._keys = keys
        self._uow = uow
        self._organizations = organizations

    async def is_first_policy_in_organization(self, organization_id: uuid.UUID) -> bool:
        """Whether the policy just stored is the only one in any of the organization's workspaces."""
        workspace_ids = await self._organizations.get_workspace_ids_in_organization(organization_id)
        async with self._uow:
            return await RoutingPolicyRepository(self._uow).count_in_workspaces(workspace_ids) == 1

    async def key_routing(self, key_ids: Sequence[str], *, organization_id: uuid.UUID) -> list[KeyRouting]:
        """For each of these keys in the organization, the names it sent in the window and what a failure on each does.

        In the order ``key_ids`` names them; a key outside the organization is left
        out like one that does not exist. A name is judged as a request from the
        key would resolve it now, not as it resolved when sent: a routing policy
        in force for the key's owner in its workspace, then an alias, then a
        catalog ID, whose offerings are narrowed to the ones a request from the
        key may reach. A policy has a backup when it can try a second candidate
        the key may reach; a catalog ID when its plan has two offerings. An
        alias's target is sent as written, so like a pinned ``provider:model`` it
        never has one. A name every request of which was imported is a
        subscription's, which the gateway never routed.
        """
        workspace_ids = await self._organizations.get_workspace_ids_in_organization(organization_id)
        reaches = await self._keys.reach(key_ids, organization_id=organization_id, workspace_ids=workspace_ids)
        if not reaches:
            return []
        position = {key_id: index for index, key_id in reversed(list(enumerate(key_ids)))}
        keys = sorted(reaches, key=lambda key: position[key.id])
        now = datetime.now(UTC)
        traffic = await self._usage.names_by_key(
            [key.id for key in keys], workspace_ids={key.workspace_id for key in keys}, since=now - FALLBACK_WINDOW
        )
        by_key: defaultdict[str, list[KeyNameTraffic]] = defaultdict(list)
        for row in traffic:
            by_key[row.api_key_id].append(row)
        return [self._key_routing(key, by_key[key.id]) for key in keys]

    def _key_routing(self, key: KeyReach, names: list[KeyNameTraffic]) -> KeyRouting:
        models: list[KeyModel] = []
        for row in names:
            coverage = (
                _Coverage("unknown", "subscription")
                if row.imported == row.requests
                else self._coverage(key, row.name, routed=row.routed)
            )
            models.append(
                KeyModel(
                    name=row.name,
                    requests=row.requests,
                    kind=coverage.kind,
                    backup=coverage.backup,
                    reason=coverage.reason,
                    provider=coverage.provider,
                )
            )
        models.sort(key=lambda model: (-model.requests, model.name))
        no_backup = [model for model in models if model.backup == "no_backup"]
        return KeyRouting(
            api_key_id=key.id,
            models=tuple(models[:KEY_MODELS_SHOWN]),
            model_count=len(models),
            no_backup_count=len(no_backup),
            no_backup=tuple(no_backup[:KEY_MODELS_SHOWN]),
            policies=tuple(
                KeyPolicy(name=model.name, requests=model.requests, deleted=model.backup == "unknown")
                for model in models
                if model.kind == "policy"
            ),
        )

    def _coverage(self, key: KeyReach, name: str, *, routed: bool) -> _Coverage:
        policy = resolve_effective_policy(self._config, name, key.user_id, workspace_id=key.workspace_id)
        if policy is not None:
            # The candidates a request from this key could try, after the same
            # allow-list and organization-key filters its compiled plan applies.
            reachable = reachable_candidates(
                self._config,
                name,
                [*(policy.router_candidates or [policy.default_target]), *policy.on_failure],
                allowlist=key.allowlist,
                workspace_id=key.workspace_id,
            )
            if len(reachable) > 1:
                return _Coverage("policy", "has_backup")
            if reachable:
                return _Coverage("policy", "no_backup", "single_target_policy", reachable[0].instance)
            return _Coverage("policy", "no_backup", "no_allowed_offering")
        target = resolve_effective_alias(self._config, name, key.user_id, workspace_id=key.workspace_id)
        if target is not None:
            # A one-target policy: the request path never fails an alias over to a catalog ID's other offerings.
            return _Coverage("alias", "no_backup", "single_target_policy", _instance(target))
        coverage = self._model_coverage(key, name)
        if routed and coverage.kind == "unknown":
            # Routing recorded it, and it is no catalog ID: a policy since deleted or renamed.
            return _Coverage("policy", "unknown")
        return coverage

    def _model_coverage(self, key: KeyReach, selector: str) -> _Coverage:
        offerings = resolve_catalog_offerings(
            selector, workspace_id=key.workspace_id, organization_id=key.organization_id
        )
        if offerings:
            # The plan a request sending the catalog ID compiles to: the same
            # filters and the same fallback to the plain path.
            plan = compile_catalog_plan(
                self._config, selector, user_id=key.user_id, allowlist=key.allowlist, workspace_id=key.workspace_id
            )
            if plan is not None and len(plan.attempts) > 1:
                return _Coverage("catalog", "has_backup")
            if plan is not None:
                return _Coverage("catalog", "no_backup", "single_offering", plan.attempts[0].instance)
            # No plan: the request takes the plain path, which serves the first offering alone.
            reachable = reachable_candidates(
                self._config, selector, offerings[:1], allowlist=key.allowlist, workspace_id=key.workspace_id
            )
            if reachable:
                return _Coverage("catalog", "no_backup", "single_offering", reachable[0].instance)
            return _Coverage("catalog", "no_backup", "no_allowed_offering")
        if ":" in selector:
            return _Coverage("pinned", "no_backup", "pinned", _instance(selector))
        return _Coverage("unknown", "unknown")

    async def name_traffic(
        self,
        *,
        workspace_ids: Collection[uuid.UUID],
        everywhere: Collection[str],
        by_workspace: Mapping[uuid.UUID, Collection[str]],
        reader: TrafficReader,
        api_key_ids: Collection[str] | None = None,
    ) -> list[NameTraffic]:
        """The traffic sent under policy and alias names in the window, per workspace, among the rows ``reader`` sees.

        A name counts in a workspace where it routes: everywhere for one
        ``everywhere`` holds (the configured policies and aliases), and in its own workspace
        for one ``by_workspace`` lists there. The same name sent where nothing
        claims it is a plain model name, not this traffic.

        A request counts once, on the row that ended it; each attempt before it
        that a later one recovered from counts as a failure of its step. A step
        served the requests whose final attempt it made and answered: a success,
        or a stream the client abandoned (``incomplete``).
        """
        candidates = set(everywhere).union(*by_workspace.values())
        rows = [
            row
            for row in await self._usage.name_attempts(
                workspace_ids=workspace_ids,
                names=candidates,
                since=datetime.now(UTC) - FALLBACK_WINDOW,
                reader=reader,
                api_key_ids=api_key_ids,
            )
            if row.name in everywhere or row.name in by_workspace.get(row.workspace_id, ())
        ]
        requests: Counter[tuple[uuid.UUID, str]] = Counter()
        keys: defaultdict[tuple[uuid.UUID, str], Counter[str]] = defaultdict(Counter)
        # Per (workspace, name), per (target, role, router): served, failed, earliest place tried.
        steps: defaultdict[tuple[uuid.UUID, str], dict[tuple[str, TargetRole, str | None], list[int]]] = defaultdict(
            dict
        )
        for row in rows:
            group = (row.workspace_id, row.name)
            role, router = _role_of(row.selection_reason)
            target = f"{row.provider}:{row.model}" if row.provider else row.model
            step = steps[group].setdefault((target, role, router), [0, 0, row.position])
            step[2] = min(step[2], row.position)
            if row.status in _ANSWERED:
                step[0] += row.attempts
            else:
                step[1] += row.attempts
            if row.status != "absorbed":
                requests[group] += row.attempts
                if row.api_key_id is not None:
                    keys[group][row.api_key_id] += row.attempts
        key_names = await self._keys.key_names(
            {key for counts in keys.values() for key in counts}, workspace_ids=workspace_ids
        )
        traffic = [
            NameTraffic(
                workspace_id=workspace_id,
                name=name,
                requests=requests[(workspace_id, name)],
                sent_by=_most_first(keys[(workspace_id, name)], key_names),
                steps=tuple(
                    sorted(
                        (
                            StepOutcome(
                                target=target, role=role, router=router, position=position, served=served, failed=failed
                            )
                            for (target, role, router), (served, failed, position) in steps[
                                (workspace_id, name)
                            ].items()
                        ),
                        key=lambda step: (step.position, _ROLE_ORDER[step.role], step.target),
                    )
                ),
            )
            for workspace_id, name in steps
        ]
        return sorted(traffic, key=lambda item: (item.name, str(item.workspace_id)))

    async def automatic_fallbacks(
        self,
        *,
        organization_id: uuid.UUID,
        workspace_ids: Collection[uuid.UUID],
        serving_workspace_id: uuid.UUID | None = None,
        reader: TrafficReader | None = None,
        api_key_ids: Collection[str] | None = None,
    ) -> list[AutomaticFallback]:
        """Every model these workspaces sent requests to in the window, most requested first.

        The catalog order is a baseline; automatic selection can reorder it
        per request. A catalog request moves to the next offering when one fails;
        one that named an offering itself
        (``bedrock:…``), an alias or a routing policy is counted as pinned. A row is
        matched to a model by the catalog ID it sent, else by the offering it
        reached, so traffic on an offering the catalog no longer serves is left
        out. The order is the catalog's, before a key's allow-list or a missing
        credential drops an offering, or automatic selection reorders it.

        ``serving_workspace_id`` keeps only the offerings a request billed to
        that workspace may call, and the models left with one.

        Each model names the keys that sent it where ``reader`` may see whose
        requests they are, and ``api_key_ids`` narrows the traffic to those keys'
        requests among the same.

        Raises:
            WorkspaceNotFoundError: ``serving_workspace_id`` is not one of
                ``workspace_ids``, the workspaces the caller may see.
        """
        if serving_workspace_id is not None and serving_workspace_id not in workspace_ids:
            raise WorkspaceNotFoundError(serving_workspace_id)
        traffic = await self._usage.served_traffic(
            workspace_ids=workspace_ids,
            since=datetime.now(UTC) - FALLBACK_WINDOW,
            reader=reader,
            api_key_ids=api_key_ids,
        )
        models = {model.id: model for model in catalog_models(organization_id=organization_id)}
        model_of = {selector: model.id for model in models.values() for selector in model.offerings}
        tallies: dict[str, _Tally] = {}
        for row in traffic:
            sent = (row.sent or "").lower()
            reached = next((selector for selector in _served_selectors(row) if selector in model_of), None)
            model_id = sent if sent in models else model_of.get(reached or "")
            if model_id is None:
                continue
            tally = tallies.setdefault(model_id, _Tally())
            tally.requests += row.requests
            tally.fell_back += row.fell_back
            if reader is not None and row.readable and row.api_key_id is not None:
                tally.keys[row.api_key_id] += row.requests
            if sent != model_id:
                provider = row.provider or (reached or row.model).partition(":")[0]
                tally.pinned[provider] += row.requests
                tally.pinned_keys[(row.api_key_id, provider)] += row.requests

        key_ids = {key_id for tally in tallies.values() for key_id, _provider in tally.pinned_keys if key_id}
        key_ids |= {key_id for tally in tallies.values() for key_id in tally.keys}
        key_names = await self._keys.key_names(key_ids, workspace_ids=workspace_ids)

        tools: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {}

        def offering(selector: str) -> FallbackOffering:
            instance = selector.partition(":")[0]
            provider_type = self._config.provider_instance_type(instance)
            if provider_type not in tools:
                answer = provider_tools(self._config, provider_type)
                tools[provider_type] = (tuple(sorted(answer.native)), tuple(sorted(answer.claimed)))
            own, otari = tools[provider_type]
            return FallbackOffering(
                selector=selector,
                provider=instance,
                provider_type=provider_type,
                input_price=offering_input_rate(selector, organization_id=organization_id),
                own_tools=own,
                otari_tools=otari,
            )

        def pinned_keys(tally: _Tally) -> tuple[PinnedTraffic, ...]:
            entries = [
                PinnedTraffic(api_key_id=key_id, key_name=key_names.get(key_id or ""), provider=provider, requests=n)
                for (key_id, provider), n in tally.pinned_keys.items()
            ]
            return tuple(sorted(entries, key=lambda entry: (-entry.requests, entry.key_name or "", entry.provider)))

        served = {
            model_id: [
                selector
                for selector in models[model_id].offerings
                if serving_workspace_id is None or workspace_serves_target(self._config, serving_workspace_id, selector)
            ]
            for model_id in tallies
        }
        fallbacks = [
            AutomaticFallback(
                id=model_id,
                name=models[model_id].name,
                offerings=tuple(offering(selector) for selector in served[model_id]),
                requests=tally.requests,
                fell_back=tally.fell_back,
                pinned=sum(tally.pinned.values()),
                pinned_provider=tally.pinned.most_common(1)[0][0] if tally.pinned else None,
                pinned_keys=pinned_keys(tally),
                sent_by=_most_first(tally.keys, key_names),
            )
            for model_id, tally in tallies.items()
            if tally.requests > 0 and served[model_id]
        ]
        return sorted(fallbacks, key=lambda fallback: (-fallback.requests, fallback.id))
