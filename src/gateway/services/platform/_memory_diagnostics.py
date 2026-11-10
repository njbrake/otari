"""Reading this process's memory, to tell allocator fragmentation from a leak."""

import asyncio
import ctypes
import gc
import heapq
import re
import sys
import threading
import tracemalloc
from collections.abc import Collection, Iterable, Mapping
from operator import itemgetter
from pathlib import Path
from typing import Any

from gateway.schemas.platform import (
    AllocationGrowth,
    AllocationStat,
    Allocator,
    HeapTrim,
    JemallocStats,
    MallinfoStats,
    MemoryDiagnostics,
    TracemallocStats,
    TypeCount,
)

_PROC_STATUS = Path("/proc/self/status")
_SITE_PACKAGES_PREFIX = re.compile(r"(?:.*[\\/])?site-packages[\\/]")
_TYPE_LABEL_MAX_CHARS = 200
_OWN_FILES = frozenset({tracemalloc.__file__, __file__})
_TRACEMALLOC_HINT = "tracemalloc is off. Set PYTHONTRACEMALLOC=1 in the environment and restart to trace allocations."

# location -> (size in bytes, allocation count)
_TracedTotals = Mapping[str, tuple[int, int]]

_JEMALLOC_STATS = ("allocated", "active", "resident", "mapped", "retained")


class _Mallinfo2(ctypes.Structure):
    """glibc's ``struct mallinfo2``, whose field order is its ABI."""

    _fields_ = [
        ("arena", ctypes.c_size_t),
        ("ordblks", ctypes.c_size_t),
        ("smblks", ctypes.c_size_t),
        ("hblks", ctypes.c_size_t),
        ("hblkhd", ctypes.c_size_t),
        ("usmblks", ctypes.c_size_t),
        ("fsmblks", ctypes.c_size_t),
        ("uordblks", ctypes.c_size_t),
        ("fordblks", ctypes.c_size_t),
        ("keepcost", ctypes.c_size_t),
    ]


def load_libc() -> Any | None:
    """The C library this process linked, or None where it cannot be opened."""
    try:
        return ctypes.CDLL(None)
    except (OSError, TypeError):
        return None


def _address(function: Any) -> int | None:
    return ctypes.cast(function, ctypes.c_void_p).value


def active_allocator(libc: Any | None) -> Allocator | None:
    """Which ``malloc`` this process calls, or None where that cannot be told.

    glibc's own ``malloc`` differing from the one the process resolves means
    another allocator was preloaded over it, whose state ``mallinfo2`` does not see.
    """
    if libc is None:
        return None
    if getattr(libc, "mallctl", None) is not None:
        return "jemalloc"
    try:
        glibc = ctypes.CDLL("libc.so.6")
        own_malloc = _address(glibc.malloc)
    except (OSError, AttributeError):
        return None
    return "glibc" if _address(libc.malloc) == own_malloc else "other"


def read_jemalloc(libc: Any) -> JemallocStats | None:
    """jemalloc's counters, refreshed by advancing its ``epoch``, or None if unreadable."""
    mallctl = libc.mallctl
    mallctl.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
    mallctl.restype = ctypes.c_int
    epoch = ctypes.c_uint64(1)
    if mallctl(b"epoch", None, None, ctypes.byref(epoch), ctypes.sizeof(epoch)) != 0:
        return None
    values: dict[str, int] = {}
    for name in _JEMALLOC_STATS:
        value = ctypes.c_size_t()
        size = ctypes.c_size_t(ctypes.sizeof(value))
        if mallctl(f"stats.{name}".encode(), ctypes.byref(value), ctypes.byref(size), None, 0) != 0:
            return None
        values[name] = value.value
    return JemallocStats(**values)


def read_mallinfo(libc: Any | None) -> MallinfoStats | None:
    """Allocator state from ``mallinfo2``, or None off glibc 2.33 and later."""
    mallinfo2 = getattr(libc, "mallinfo2", None)
    if mallinfo2 is None:
        return None
    mallinfo2.restype = _Mallinfo2
    info = mallinfo2()
    return MallinfoStats(
        arena=info.arena,
        hblkhd=info.hblkhd,
        uordblks=info.uordblks,
        fordblks=info.fordblks,
        keepcost=info.keepcost,
    )


def trim_heap(libc: Any | None) -> bool | None:
    """Run ``malloc_trim(0)``: whether it released memory, or None off glibc."""
    malloc_trim = getattr(libc, "malloc_trim", None)
    if malloc_trim is None:
        return None
    malloc_trim.argtypes = [ctypes.c_size_t]
    malloc_trim.restype = ctypes.c_int
    released: int = malloc_trim(0)
    return released == 1


def parse_proc_status(status: str) -> tuple[int | None, int | None]:
    """``(VmRSS, VmHWM)`` in bytes from the text of ``/proc/self/status``."""
    return _status_bytes(status, "VmRSS"), _status_bytes(status, "VmHWM")


def _status_bytes(status: str, field: str) -> int | None:
    match = re.search(rf"^{field}:\s*(\d+)\s*kB", status, re.MULTILINE)
    return int(match[1]) * 1024 if match else None


def _read_rss() -> tuple[int | None, int | None]:
    try:
        return parse_proc_status(_PROC_STATUS.read_text())
    except OSError:
        return None, None


def strip_site_packages(filename: str) -> str:
    """A traced filename without its installation prefix."""
    return _SITE_PACKAGES_PREFIX.sub("", filename, count=1)


def _type_label(kind: type) -> str:
    module = getattr(kind, "__module__", "builtins")
    label = kind.__qualname__ if module == "builtins" else f"{module}.{kind.__qualname__}"
    return label[:_TYPE_LABEL_MAX_CHARS]


def top_types(objects: Iterable[object], limit: int) -> list[TypeCount]:
    """The ``limit`` most numerous types among ``objects``."""
    counts: dict[type, int] = {}
    # Not Counter(map(type, ...)): that loop runs in C and keeps the GIL until it
    # ends, where this one lets the event loop in between bytecodes.
    for obj in objects:
        kind = type(obj)
        counts[kind] = counts.get(kind, 0) + 1
    largest = heapq.nlargest(limit, counts.items(), key=itemgetter(1))
    return [TypeCount(type=_type_label(kind), count=count) for kind, count in largest]


def traced_totals(
    statistics: Iterable[tracemalloc.Statistic], *, excluded: Collection[str] = ()
) -> dict[str, tuple[int, int]]:
    """Per-line statistics, keyed by ``file:line`` with the install prefix gone."""
    totals: dict[str, tuple[int, int]] = {}
    for statistic in statistics:
        frame = statistic.traceback[0]
        if frame.filename in excluded:
            continue
        location = f"{strip_site_packages(frame.filename)}:{frame.lineno}"
        size, count = totals.get(location, (0, 0))
        totals[location] = (size + statistic.size, count + statistic.count)
    return totals


def by_file(totals: _TracedTotals) -> dict[str, tuple[int, int]]:
    """Per-line totals merged per file, so a package's share reads as one row."""
    merged: dict[str, tuple[int, int]] = {}
    for location, (size, count) in totals.items():
        filename = location.rpartition(":")[0]
        merged_size, merged_count = merged.get(filename, (0, 0))
        merged[filename] = (merged_size + size, merged_count + count)
    return merged


def top_allocations(totals: _TracedTotals, limit: int) -> list[AllocationStat]:
    """The ``limit`` lines holding the most traced memory."""
    largest = heapq.nlargest(limit, totals.items(), key=lambda item: item[1][0])
    return [AllocationStat(location=location, size_bytes=size, count=count) for location, (size, count) in largest]


def top_growth(totals: _TracedTotals, baseline: _TracedTotals, limit: int) -> list[AllocationGrowth]:
    """The ``limit`` lines that have grown most since ``baseline``."""
    grown = (
        (location, size - baseline.get(location, (0, 0))[0], count - baseline.get(location, (0, 0))[1])
        for location, (size, count) in totals.items()
    )
    largest = heapq.nlargest(limit, (row for row in grown if row[1] > 0), key=itemgetter(1))
    return [
        AllocationGrowth(location=location, size_diff_bytes=size, count_diff=count) for location, size, count in largest
    ]


class MemoryDiagnosticsService:
    """Reads this process's memory and keeps its one tracemalloc baseline.

    The baseline is the per-line totals rather than a ``Snapshot``, whose every
    trace would otherwise stay on the heap being measured.
    """

    def __init__(self) -> None:
        self._baseline: dict[str, tuple[int, int]] | None = None
        self._lock = threading.Lock()

    async def read(self, *, limit: int, reset_baseline: bool, trim: bool) -> MemoryDiagnostics:
        """Measure off the event loop.

        ``gc.get_objects`` and ``take_snapshot`` still hold the GIL while they
        run, so a call stalls requests for as long as those two C calls take.
        """
        return await asyncio.to_thread(self._measure, limit, reset_baseline, trim)

    def _measure(self, limit: int, reset_baseline: bool, trim: bool) -> MemoryDiagnostics:
        with self._lock:
            libc = load_libc()
            # The cheap readings go first, before the snapshot and the object
            # walk allocate on the heap they describe.
            rss_bytes, peak_rss_bytes = _read_rss()
            allocator = active_allocator(libc)
            # mallinfo2 and malloc_trim describe glibc's heap even when another
            # allocator serves every request, so they are read only on glibc.
            mallinfo = read_mallinfo(libc) if allocator == "glibc" else None
            jemalloc = read_jemalloc(libc) if allocator == "jemalloc" else None
            allocated_blocks = sys.getallocatedblocks()
            gc_count = gc.get_count()

            tracing = tracemalloc.is_tracing()
            traced = self._trace(limit, reset_baseline) if tracing else None
            types = top_types(gc.get_objects(), limit)

            return MemoryDiagnostics(
                rss_bytes=rss_bytes,
                peak_rss_bytes=peak_rss_bytes,
                allocator=allocator,
                mallinfo=mallinfo,
                jemalloc=jemalloc,
                allocated_blocks=allocated_blocks,
                gc_count=gc_count,
                top_types=types,
                tracemalloc=traced,
                tracemalloc_hint=None if tracing else _TRACEMALLOC_HINT,
                trim=_trim(libc) if trim and allocator == "glibc" else None,
            )

    def _trace(self, limit: int, reset_baseline: bool) -> TracemallocStats:
        current_bytes, peak_bytes = tracemalloc.get_traced_memory()
        totals = traced_totals(tracemalloc.take_snapshot().statistics("lineno"), excluded=_OWN_FILES)
        baseline_taken = reset_baseline or self._baseline is None
        if baseline_taken:
            self._baseline = totals
        return TracemallocStats(
            current_bytes=current_bytes,
            peak_bytes=peak_bytes,
            baseline_taken=baseline_taken,
            top_allocations=top_allocations(totals, limit),
            top_files=top_allocations(by_file(totals), limit),
            top_growth=top_growth(totals, self._baseline or {}, limit),
        )


def _trim(libc: Any | None) -> HeapTrim | None:
    rss_before_bytes, _ = _read_rss()
    released = trim_heap(libc)
    if released is None:
        return None
    rss_after_bytes, _ = _read_rss()
    return HeapTrim(rss_before_bytes=rss_before_bytes, rss_after_bytes=rss_after_bytes, released=released)
