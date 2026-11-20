"""The signed-in identity's own dashboard preferences (``/api/v1/me/preferences``).

Each route acts on the caller's own identity and takes no id, so one person can
never read or write another's. A dashboard session is the caller it was minted
for, and a header master key is the deployment's bootstrap operator, as on
``/api/v1/auth/profile``. An API key names no dashboard identity, so it is
refused with the 401 the rest of the management API gives it.
"""

from fastapi import APIRouter, Depends, Response, status

from gateway.api.deps import CurrentIdentity, PreferenceServiceDep, verify_master_key
from gateway.models.preferences import PreferenceKey
from gateway.schemas.preferences import UserPreferencePublic, UserPreferenceUpdate

router = APIRouter(
    prefix="/me/preferences",
    tags=["preferences"],
    dependencies=[Depends(verify_master_key)],
)


@router.get("/{key}")
async def get_own_preference(
    key: PreferenceKey, identity: CurrentIdentity, service: PreferenceServiceDep
) -> UserPreferencePublic:
    """Read what the caller stored under ``key``. Nothing stored answers 200 with a null value."""
    return await service.get(identity.id, key)


@router.put("/{key}")
async def put_own_preference(
    key: PreferenceKey, body: UserPreferenceUpdate, identity: CurrentIdentity, service: PreferenceServiceDep
) -> UserPreferencePublic:
    """Store a value under ``key`` for the caller, replacing what was there. Over 16 KiB answers 422."""
    return await service.put(identity.id, key, body)


@router.delete("/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_own_preference(
    key: PreferenceKey, identity: CurrentIdentity, service: PreferenceServiceDep
) -> Response:
    """Forget what the caller stored under ``key``, so the dashboard's defaults apply again."""
    await service.clear(identity.id, key)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


__all__ = ["router"]
