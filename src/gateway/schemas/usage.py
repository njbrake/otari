"""Response models of the usage log's activity groups."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from gateway.core.sql import utc_bound

# The columns the activity log can be collapsed on.
ActivityGroupBy = Literal["api_key", "source_label", "model", "user", "policy", "alias"]
# Most recently active first, or busiest first.
ActivityGroupOrder = Literal["recent", "requests"]


class UsageActivityGroup(BaseModel):
    """One group of the activity log: every request sharing a key, session, model, user, policy or alias.

    ``key`` is None for the rows that have no value in the grouped column (no
    key, no session, no billed user); filter to them with ``is_null``, or for
    policy, ``routed=false``. Token counts are billed quantities (see
    ``billed_meter``), and ``latency_ms`` is the summed total latency of the
    requests counted, the model time the group took.
    """

    # Built from the read repository's group rows by attribute.
    model_config = ConfigDict(from_attributes=True)

    key: str | None
    label: str | None = None
    requests: int
    errors: int
    absorbed: int
    # Every row's cost, imported usage's included. ``imported_cost`` is the part
    # from rows this deployment did not serve, so the gateway's own spend is
    # ``cost - imported_cost``, as on the summary's totals.
    cost: float
    imported_cost: float
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    latency_ms: int
    first_at: str
    last_at: str
    # The group's most-used models, most requests first, and how many distinct
    # models its rows name in all, an absorbed attempt's included.
    models: list[str]
    model_count: int

    @field_validator("first_at", "last_at", mode="before")
    @classmethod
    def _utc_iso(cls, value: object) -> object:
        return utc_bound(value).isoformat() if isinstance(value, datetime) else value


class UsageActivityGroups(BaseModel):
    """A page of activity groups in the order asked for, and how many there are."""

    start_date: str
    end_date: str
    group_by: ActivityGroupBy
    groups: list[UsageActivityGroup]
    total: int
