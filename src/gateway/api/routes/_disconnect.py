"""A route whose read stops when its caller goes away."""

import asyncio
import contextlib
from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Request, Response
from fastapi.routing import APIRoute
from starlette.types import Receive

# What nginx logs for a request its client closed. Nobody receives it, and
# uvicorn's access log skips a send to a closed connection, so the request
# metrics are what record it.
CLIENT_CLOSED_REQUEST = 499


async def _until_disconnected(receive: Receive) -> None:
    """Return once the client has gone. A GET carries no body, so nothing else reads ``receive``."""
    while (await receive())["type"] != "http.disconnect":
        pass


class CancelOnDisconnectRoute(APIRoute):
    """A route whose ``GET`` handler is cancelled when the client disconnects.

    A server keeps running a handler whose client has left, so an aggregate the
    dashboard gave up on (a page reloaded, a request past the browser's deadline)
    still holds its database query and its turn at the heavy-read gate, and the
    reads that replace it queue behind it. Cancelling the handler cancels the
    query and gives the turn back. Only ``GET`` routes are cancelled: a write
    stopped partway is worse than one finished for nobody.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()
        if self.methods != {"GET"}:
            return handler

        async def cancel_on_disconnect(request: Request) -> Response:
            work = asyncio.ensure_future(handler(request))
            gone = asyncio.ensure_future(_until_disconnected(request.receive))
            try:
                await asyncio.wait((work, gone), return_when=asyncio.FIRST_COMPLETED)
            finally:
                gone.cancel()
                if not work.done():
                    work.cancel()
                    # The handler's own cleanup (its gate turn, its transaction) runs before this returns.
                    with contextlib.suppress(asyncio.CancelledError):
                        await work
            if work.cancelled():
                return Response(status_code=CLIENT_CLOSED_REQUEST)
            return work.result()

        return cancel_on_disconnect
