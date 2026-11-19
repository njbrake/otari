"""The usage domain: the rows each request served or imported leaves behind.

``UsageService`` is its service. ``TelemetryRetentionService`` deletes imported rows
past ``telemetry_retention_days``, and ``UsageRollupService`` keeps current the hourly
rollups the aggregate reads take whole hours from. The bulk mutations are still in
the old shape (``services/usage_admin_service.py``) and move here when the rest of
the domain does.
"""

from gateway.repositories.usage_and_telemetry import ServedTraffic, UsageFilters, UsageScope
from gateway.services.usage_and_telemetry._read_gate import HeavyUsageReads
from gateway.services.usage_and_telemetry._retention import RetentionSweep, TelemetryRetentionService
from gateway.services.usage_and_telemetry._rollups import UsageRollupService
from gateway.services.usage_and_telemetry._service import UsageService
from gateway.services.usage_and_telemetry._video_usage_writer import VideoUsageWriter
from gateway.services.usage_and_telemetry._window import (
    MAX_SERIES_POINTS,
    SERIES_TOP_N,
    dense_series,
    error_class_for,
    parse_tag_filters,
    resolve_window,
)

__all__ = [
    "MAX_SERIES_POINTS",
    "SERIES_TOP_N",
    "HeavyUsageReads",
    "RetentionSweep",
    "ServedTraffic",
    "TelemetryRetentionService",
    "UsageRollupService",
    "UsageFilters",
    "UsageScope",
    "UsageService",
    "VideoUsageWriter",
    "dense_series",
    "error_class_for",
    "parse_tag_filters",
    "resolve_window",
]
