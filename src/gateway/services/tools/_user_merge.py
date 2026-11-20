"""Moving a merged user's MCP grants, connections and sign-ins onto the user it was merged into."""

from collections.abc import Mapping

from gateway.core.unit_of_work import UnitOfWork
from gateway.repositories.tools import (
    McpOAuthFlowRepository,
    McpUserConnectionRepository,
    WorkspaceMcpServerGrantRepository,
)


class McpUserMergeListener:
    """Moves a merged user's MCP state inside the caller's Unit of Work block.

    A grant or a connection is one per server and user, so where the user merged
    into already holds one for a server it keeps its own, and the merged user's
    is dropped rather than moved.
    """

    def __init__(self, uow: UnitOfWork) -> None:
        self._grants = WorkspaceMcpServerGrantRepository(uow)
        self._connections = McpUserConnectionRepository(uow)
        self._flows = McpOAuthFlowRepository(uow)

    async def user_merged(self, from_user_id: str, to_user_id: str) -> Mapping[str, int]:
        """Point the grants, connections and sign-ins in progress at ``to_user_id``, keeping its own on a clash."""
        await self._grants.drop_shared_with_user(from_user_id, to_user_id, by="server_id")
        await self._connections.drop_shared_with_user(from_user_id, to_user_id, by="server_id")
        return {
            "workspace_mcp_server_grants": await self._grants.reassign_user(from_user_id, to_user_id),
            "mcp_user_connections": await self._connections.reassign_user(from_user_id, to_user_id),
            "mcp_oauth_flows": await self._flows.reassign_user(from_user_id, to_user_id),
        }
