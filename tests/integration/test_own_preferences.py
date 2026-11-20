"""The signed-in identity's own dashboard preferences: ``/api/v1/me/preferences/{key}``."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from gateway.core.config import API_ROOT
from gateway.models.preferences import MAX_PREFERENCE_BYTES, UserPreference
from gateway.models.tenancy import DashboardSession, User
from gateway.services.dashboard_session_service import SESSION_COOKIE_NAME, hash_session_token

SESSIONS = f"{API_ROOT}/me/preferences/table:sessions"
REQUESTS = f"{API_ROOT}/me/preferences/table:requests"
LAYOUT = {"version": 1, "widths": {"model": 240}, "hidden": ["routing"]}


def _identity(session_factory: Callable[[], Session], email: str) -> tuple[uuid.UUID, str]:
    """An active identity and a dashboard session token minted for it."""
    session = session_factory()
    try:
        identity = User(email=email, active_organization_id=None)
        session.add(identity)
        session.flush()
        token = f"otari-sess-{uuid.uuid4().hex}"
        session.add(
            DashboardSession(
                token_hash=hash_session_token(token),
                user_id=identity.id,
                created_at=datetime.now(UTC),
                expires_at=datetime.now(UTC) + timedelta(hours=12),
            )
        )
        session.commit()
        return identity.id, token
    finally:
        session.close()


def _as(client: TestClient, token: str) -> TestClient:
    client.cookies.set(SESSION_COOKIE_NAME, token)
    return client


def _stored(session_factory: Callable[[], Session], identity_id: uuid.UUID) -> list[UserPreference]:
    session = session_factory()
    try:
        return list(session.scalars(select(UserPreference).where(UserPreference.user_id == identity_id)))
    finally:
        session.close()


def test_an_unset_preference_reads_as_no_value(
    client: TestClient, db_session_factory: Callable[[], Session]
) -> None:
    _, token = _identity(db_session_factory, "ada@example.com")
    response = _as(client, token).get(SESSIONS)
    assert response.status_code == 200, response.text
    assert response.json() == {"key": "table:sessions", "value": None, "updated_at": None}


def test_a_preference_round_trips_and_a_write_replaces_it(
    client: TestClient, db_session_factory: Callable[[], Session]
) -> None:
    _, token = _identity(db_session_factory, "ada@example.com")
    _as(client, token)

    written = client.put(SESSIONS, json={"value": LAYOUT})
    assert written.status_code == 200, written.text
    assert written.json()["value"] == LAYOUT
    assert written.json()["updated_at"] is not None
    assert client.get(SESSIONS).json()["value"] == LAYOUT

    replaced = client.put(SESSIONS, json={"value": {"version": 1, "hidden": []}})
    assert replaced.status_code == 200, replaced.text
    assert client.get(SESSIONS).json()["value"] == {"version": 1, "hidden": []}
    # Keys are independent.
    assert client.get(REQUESTS).json()["value"] is None


def test_clearing_a_preference_returns_it_to_the_defaults(
    client: TestClient, db_session_factory: Callable[[], Session]
) -> None:
    _, token = _identity(db_session_factory, "ada@example.com")
    _as(client, token).put(REQUESTS, json={"value": LAYOUT})

    assert client.delete(REQUESTS).status_code == 204
    assert client.get(REQUESTS).json()["value"] is None
    # Clearing what is not there is not an error.
    assert client.delete(REQUESTS).status_code == 204


def test_one_identity_never_sees_another_identitys_preferences(
    client: TestClient, db_session_factory: Callable[[], Session], master_key_header: dict[str, str]
) -> None:
    _, ada = _identity(db_session_factory, "ada@example.com")
    _, grace = _identity(db_session_factory, "grace@example.com")
    assert _as(client, ada).put(SESSIONS, json={"value": LAYOUT}).status_code == 200

    assert _as(client, grace).get(SESSIONS).json()["value"] is None
    assert client.put(SESSIONS, json={"value": {"hidden": ["tags"]}}).status_code == 200
    client.cookies.clear()
    # The master key is the bootstrap operator, a third identity.
    assert client.get(SESSIONS, headers=master_key_header).json()["value"] is None

    assert _as(client, ada).get(SESSIONS).json()["value"] == LAYOUT
    assert _as(client, grace).get(SESSIONS).json()["value"] == {"hidden": ["tags"]}


def test_a_value_over_the_limit_is_refused_and_nothing_is_stored(
    client: TestClient, db_session_factory: Callable[[], Session]
) -> None:
    identity_id, token = _identity(db_session_factory, "ada@example.com")
    too_big = {"blob": "x" * MAX_PREFERENCE_BYTES}
    response = _as(client, token).put(SESSIONS, json={"value": too_big})
    assert response.status_code == 422, response.text
    assert _stored(db_session_factory, identity_id) == []

    just_fits: dict[str, Any] = {"blob": "x" * (MAX_PREFERENCE_BYTES - len('{"blob":""}'))}
    assert client.put(SESSIONS, json={"value": just_fits}).status_code == 200


def test_an_unknown_key_or_a_non_object_value_is_refused(
    client: TestClient, db_session_factory: Callable[[], Session]
) -> None:
    identity_id, token = _identity(db_session_factory, "ada@example.com")
    _as(client, token)
    assert client.get(f"{API_ROOT}/me/preferences/table:secrets").status_code == 422
    assert client.put(f"{API_ROOT}/me/preferences/theme", json={"value": {}}).status_code == 422
    assert client.put(SESSIONS, json={"value": ["not", "an", "object"]}).status_code == 422
    assert client.put(SESSIONS, json={"value": {}, "user_id": str(uuid.uuid4())}).status_code == 422
    assert _stored(db_session_factory, identity_id) == []


def test_preferences_need_a_dashboard_credential(client: TestClient, api_key_header: dict[str, str]) -> None:
    client.cookies.clear()
    assert client.get(SESSIONS).status_code == 401
    assert client.put(SESSIONS, json={"value": LAYOUT}).status_code == 401
    # An API key names no dashboard identity.
    assert client.get(SESSIONS, headers=api_key_header).status_code == 401


def test_an_identitys_preferences_go_with_it(
    client: TestClient, db_session_factory: Callable[[], Session]
) -> None:
    identity_id, token = _identity(db_session_factory, "ada@example.com")
    assert _as(client, token).put(SESSIONS, json={"value": LAYOUT}).status_code == 200
    assert len(_stored(db_session_factory, identity_id)) == 1

    session = db_session_factory()
    try:
        identity = session.get(User, identity_id)
        assert identity is not None
        session.delete(identity)
        session.commit()
    finally:
        session.close()
    assert _stored(db_session_factory, identity_id) == []
