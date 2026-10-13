"""Request and response models of the organizations domain's workspace settings."""

from pydantic import BaseModel, Field

from gateway.models.tenancy import Workspace

_MEMBERS_SEE_WORKSPACE_TOTALS_DESC = (
    "Whether members may read the workspace's aggregate usage (totals, series, and breakdowns by model, "
    "provider or status code) and its budget's dollar figures. Never anyone else's requests, keys or limits. "
    "When false, a member reads only their own usage and the budget as a percentage."
)


class WorkspaceVisibility(BaseModel):
    """What a workspace shows members who do not manage it."""

    members_see_workspace_totals: bool = Field(description=_MEMBERS_SEE_WORKSPACE_TOTALS_DESC)

    @classmethod
    def of(cls, workspace: Workspace) -> "WorkspaceVisibility":
        """Read the settings from the workspace row."""
        return cls(members_see_workspace_totals=workspace.members_see_workspace_totals)


class WorkspaceVisibilityUpdate(BaseModel):
    """A change to what a workspace shows its members: only the fields sent change."""

    members_see_workspace_totals: bool | None = Field(default=None, description=_MEMBERS_SEE_WORKSPACE_TOTALS_DESC)
