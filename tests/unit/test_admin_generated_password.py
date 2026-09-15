"""An operator generating a password for another account: ``POST /api/v1/admin/users/{user_id}/password``.

For a deployment that sends no mail, where the signup claim and the reset link
are unavailable, so a member added by address has no other way to a password.

Unit rather than integration, matching ``test_password_sign_in.py``: route,
service and identity behavior that runs unchanged on the SQLite file each test
stands up.
"""

from pathlib import Path

from fastapi.testclient import TestClient

from gateway.core.config import API_ROOT, GatewayConfig
from gateway.main import create_app

MASTER_KEY = "sk-test-master"
HEADER = {"Otari-Key": MASTER_KEY}
MEMBER_EMAIL = "member@example.com"


def _client(tmp_path: Path) -> TestClient:
    config = GatewayConfig(
        database_url=f"sqlite:///{tmp_path / 'generated-password-test.db'}",
        master_key=MASTER_KEY,
        require_pricing=False,
    )
    return TestClient(create_app(config))


def _add_member(client: TestClient, email: str = MEMBER_EMAIL) -> str:
    response = client.post(f"{API_ROOT}/organizations/me/members", json={"email": email}, headers=HEADER)
    assert response.status_code == 201, response.text
    return _account(client, lambda row: row["email"] == email)["id"]


def _account(client: TestClient, match: object) -> dict[str, str]:
    response = client.get(f"{API_ROOT}/admin/users", headers=HEADER)
    assert response.status_code == 200, response.text
    rows = [row for row in response.json()["data"] if match(row)]  # type: ignore[operator]
    assert len(rows) == 1, rows
    row: dict[str, str] = rows[0]
    return row


def _generate(client: TestClient, user_id: str) -> str:
    response = client.post(f"{API_ROOT}/admin/users/{user_id}/password", headers=HEADER)
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers["Cache-Control"]
    password: str = response.json()["password"]
    return password


def _sign_in(client: TestClient, password: str, email: str = MEMBER_EMAIL) -> int:
    return client.post(f"{API_ROOT}/auth/session", json={"email": email, "password": password}).status_code


def test_a_generated_password_signs_a_member_in_without_mail(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        password = _generate(client, _add_member(client))

        member = TestClient(client.app)
        assert _sign_in(member, password) == 200
        assert member.get(f"{API_ROOT}/organizations/me").status_code == 200


def test_generating_again_retires_the_old_password_and_its_sessions(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        member_id = _add_member(client)
        first = _generate(client, member_id)
        member = TestClient(client.app)
        assert _sign_in(member, first) == 200

        second = _generate(client, member_id)

        assert second != first
        assert member.get(f"{API_ROOT}/organizations/me").status_code == 401
        assert _sign_in(TestClient(client.app), first) == 401
        assert _sign_in(TestClient(client.app), second) == 200


def test_an_operator_cannot_generate_their_own_password(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        own = _account(client, lambda row: row["is_self"])

        response = client.post(f"{API_ROOT}/admin/users/{own['id']}/password", headers=HEADER)

        assert response.status_code == 400, response.text


def test_an_unknown_account_is_not_found(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.post(f"{API_ROOT}/admin/users/00000000-0000-0000-0000-000000000000/password", headers=HEADER)

        assert response.status_code == 404, response.text


def test_a_member_who_is_not_an_operator_is_refused_with_404(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        member_id = _add_member(client)
        other_id = _add_member(client, "other@example.com")
        member = TestClient(client.app)
        assert _sign_in(member, _generate(client, member_id)) == 200

        response = member.post(f"{API_ROOT}/admin/users/{other_id}/password")

        assert response.status_code == 404, response.text
