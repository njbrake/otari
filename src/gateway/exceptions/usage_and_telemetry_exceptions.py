"""Errors that the usage-and-telemetry domain may raise.

Each carries the HTTP status it renders as.
"""

from fastapi import status

from gateway.exceptions import TenancyError, TenancyValidationError


class UsageTagFilterError(TenancyValidationError):
    """A tag filter that is not written ``key:value``."""

    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT

    def __init__(self) -> None:
        super().__init__("A tag filter must be written key:value")


class UsageSeriesTooLongError(TenancyValidationError):
    """A grouped series whose window holds more buckets than one response may carry."""

    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT

    def __init__(self, limit: int, bucket: str) -> None:
        super().__init__(f"window spans more than {limit} {bucket} buckets; use bucket=day or narrow the range")


class UsageReadsBusyError(TenancyError):
    """Every heavy usage read this worker allows is running, and this one waited too long for a turn.

    A 503 the caller can retry, and a 5xx whose message is the caller's to read:
    it names the condition and what to do about it, and nothing about the
    deployment beyond that it is busy.
    """

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    detail_is_public = True

    def __init__(self) -> None:
        super().__init__("Usage reads are busy; try again shortly")
