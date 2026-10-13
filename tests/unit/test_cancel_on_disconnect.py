"""A read whose caller leaves stops, so it gives back what it holds; a write finishes."""

import asyncio
from typing import Any

from fastapi import APIRouter, FastAPI

from gateway.api.routes._disconnect import CancelOnDisconnectRoute


class _Handler:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.finished = False
        self.cancelled = False
        self.cleaned_up = False

    async def run(self, *, wait: float = 0) -> dict[str, bool]:
        self.started.set()
        try:
            await asyncio.sleep(wait)
            self.finished = True
            return {"ok": True}
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        finally:
            self.cleaned_up = True


def _app(handler: _Handler) -> FastAPI:
    router = APIRouter(route_class=CancelOnDisconnectRoute)

    @router.get("/slow")
    async def slow() -> dict[str, bool]:
        return await handler.run(wait=10)

    @router.get("/fast")
    async def fast() -> dict[str, bool]:
        return await handler.run()

    @router.post("/write")
    async def write() -> dict[str, bool]:
        return await handler.run(wait=0.05)

    app = FastAPI()
    app.include_router(router)
    return app


async def _call(app: FastAPI, method: str, path: str, *, leave: asyncio.Event | None) -> list[dict[str, Any]]:
    """Call the app as uvicorn would, the client going away once ``leave`` is set."""
    messages: list[dict[str, Any]] = [{"type": "http.request", "body": b"", "more_body": False}]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        if leave is None:
            await asyncio.Event().wait()
        else:
            await leave.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [],
        "client": ("127.0.0.1", 1),
        "server": ("127.0.0.1", 80),
    }
    await app(scope, receive, send)
    return sent


def test_a_read_whose_client_leaves_is_cancelled_and_cleans_up() -> None:
    handler = _Handler()

    async def main() -> list[dict[str, Any]]:
        leave = asyncio.Event()
        call = asyncio.create_task(_call(_app(handler), "GET", "/slow", leave=leave))
        await handler.started.wait()
        leave.set()
        return await asyncio.wait_for(call, timeout=2)

    sent = asyncio.run(main())

    assert handler.cancelled
    assert handler.cleaned_up
    assert not handler.finished
    assert sent[0]["status"] == 499


def test_a_read_whose_client_stays_answers() -> None:
    handler = _Handler()

    sent = asyncio.run(_call(_app(handler), "GET", "/fast", leave=None))

    assert handler.finished
    assert sent[0]["status"] == 200
    assert sent[1]["body"] == b'{"ok":true}'


def test_a_write_whose_client_leaves_still_finishes() -> None:
    handler = _Handler()

    async def main() -> None:
        leave = asyncio.Event()
        call = asyncio.create_task(_call(_app(handler), "POST", "/write", leave=leave))
        await handler.started.wait()
        leave.set()
        await asyncio.wait_for(call, timeout=2)

    asyncio.run(main())

    assert handler.finished
    assert not handler.cancelled
