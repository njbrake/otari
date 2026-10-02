"""The time-series conventions the usage reads and the agent-telemetry summary share.

A summary read from both has to describe the same window the same way, so the
bucket grid's fill, its size bound and the stacked series' fold live here once.
"""

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

from gateway.core.sql import BUCKET_FORMATS, BUCKET_SECONDS, UsageBucketGrain

# How many groups a grouped time series carries before the remainder folds into
# "other". Eight is the ceiling a stacked chart can keep legible (and the size of
# the dashboard's fixed categorical palette); the breakdown tables, not the chart,
# are the place to read a longer tail.
SERIES_TOP_N = 8

# Upper bound on zero-filled series points, so a pathological range/bucket combo
# (e.g. hourly over a year) cannot balloon the payload; beyond it the endpoint
# returns the sparse populated buckets instead.
MAX_SERIES_POINTS = 1000


def grid_start(start: datetime, bucket: UsageBucketGrain) -> datetime:
    """The start of the UTC bucket ``start`` falls in. Bucket starts are whole multiples of the step since the epoch."""
    seconds = BUCKET_SECONDS[bucket]
    return datetime.fromtimestamp(start.timestamp() // seconds * seconds, UTC)


def dense_series[PointT](
    start: datetime,
    end: datetime,
    bucket: UsageBucketGrain,
    populated: dict[str, PointT],
    empty: Callable[[str], PointT],
) -> list[PointT]:
    """Fill every bucket in ``[floor(start), end)`` so the chart's x-axis is linear
    in time. ``GROUP BY`` omits empty buckets, so without this a sparse range (say
    usage on day 1 and day 20 of a month) would render as two adjacent bars and
    misread the trend. Falls back to the sparse buckets past ``MAX_SERIES_POINTS``.
    An empty window (no rows at all) returns an empty series, not a wall of zeros.

    ``empty`` builds the zero point for a gap, which is what lets each series type
    share this fill rather than restate it.
    """
    if not populated:
        return []
    step = timedelta(seconds=BUCKET_SECONDS[bucket])
    fmt = BUCKET_FORMATS[bucket]
    cursor = grid_start(start, bucket)
    points: list[PointT] = []
    while cursor < end:
        if len(points) >= MAX_SERIES_POINTS:
            return [populated[key] for key in sorted(populated)]
        key = cursor.strftime(fmt)
        points.append(populated.get(key) or empty(key))
        cursor += step
    return points
