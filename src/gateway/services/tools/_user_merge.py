"""Moving a merged user's MCP grants, connections and sign-ins onto the user it was merged into."""

import uuid
from collections.abc import Collection, Mapping

from gateway.core.unit_of_work import UnitOfWork
from gateway.repositories.tools import (
    McpOAuthFlowRepository,
    McpUserConnectionRepository,
    WorkspaceMcpServerGrantRepository,
    WorkspaceMcpServerRepository,
)
from gateway.services.tools._mcp_connections import McpRevocation, collect_revocations, revoke_in_background


class McpUserMergeListener:
    """Moves a merged user's MCP state inside the caller's Unit of Work block.

    A grant or a connection is one per server and user, so where the user merged
    into already holds one for a server it keeps its own, and the merged user's
    is dropped rather than moved. A dropped connection's authorization server is
    asked to end its tokens once the merge commits, as a deleted user's are.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        self._grants = WorkspaceMcpServerGrantRepository(uow)
        self._connections = McpUserConnectionRepository(uow)
        self._servers = WorkspaceMcpServerRepository(uow)
        self._flows = McpOAuthFlowRepository(uow)
        self._revocations: list[McpRevocation] = []
        self._unread = 0

    async def rows_elsewhere(self, user_id: str, workspace_ids: Collection[uuid.UUID]) -> list[str]:
        """The tables holding a row of ``user_id`` in a workspace other than these."""
        tables = {
            "workspace_mcp_server_grants": await self._grants.values_for_user(user_id, "server_id"),
            "mcp_user_connections": await self._connections.values_for_user(user_id, "server_id"),
            "mcp_oauth_flows": await self._flows.values_for_user(user_id, "server_id"),
        }
        servers = await self._servers.find_many(set().union(*tables.values()))
        elsewhere = {server.id for server in servers if server.workspace_id not in workspace_ids}
        return [table for table, server_ids in tables.items() if server_ids & elsewhere]

    async def user_merged(
        self, from_user_id: str, to_user_id: str, *, preview: bool, resumed: bool
    ) -> Mapping[str, int]:
        """Point the grants, connections and sign-ins in progress at ``to_user_id``, keeping its own on a clash.

        With ``preview`` count what would move, a dropped grant or connection left out.
        """
        clashing_grants = len(await self._grants.shared_with_user(from_user_id, to_user_id, by=("server_id",)))
        clashing = {
            uuid.UUID(str(server_id))
            for (server_id,) in await self._connections.shared_with_user(from_user_id, to_user_id, by=("server_id",))
        }
        if preview:
            return {
                "workspace_mcp_server_grants": await self._grants.count_naming_user(from_user_id) - clashing_grants,
                "mcp_user_connections": await self._connections.count_naming_user(from_user_id) - len(clashing),
                "mcp_oauth_flows": await self._flows.count_naming_user(from_user_id),
            }
        if clashing:
            # Read before the rows go, while their servers still hold the clients the tokens were issued to.
            self._revocations, self._unread = await collect_revocations(
                self._connections, self._servers, server_ids=clashing, user_id=from_user_id
            )
        await self._grants.drop_shared_with_user(from_user_id, to_user_id, by="server_id")
        await self._connections.drop_shared_with_user(from_user_id, to_user_id, by="server_id")
        return {
            "workspace_mcp_server_grants": await self._grants.reassign_user(from_user_id, to_user_id),
            "mcp_user_connections": await self._connections.reassign_user(from_user_id, to_user_id),
            "mcp_oauth_flows": await self._flows.reassign_user(from_user_id, to_user_id),
        }

    async def merge_committed(self) -> None:
        """Ask the authorization servers to end the dropped connections' tokens, without waiting."""
        revoke_in_background(self._revocations, unread=self._unread)
        self._revocations, self._unread = [], 0
