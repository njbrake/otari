"""Pure helpers behind the memory diagnostics endpoint."""

import tracemalloc
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from gateway.services.platform import MemoryDiagnosticsService, _memory_diagnostics
from gateway.services.platform._memory_diagnostics import (
    by_file,
    load_libc,
    parse_proc_status,
    read_mallinfo,
    strip_site_packages,
    top_allocations,
    top_growth,
    top_types,
    traced_totals,
    trim_heap,
)

_STATUS = "Name:\tpython\nVmPeak:\t  9999 kB\nVmHWM:\t  2048 kB\nVmRSS:\t  1024 kB\nThreads:\t4\n"


def test_parse_proc_status_converts_kilobytes() -> None:
    assert parse_proc_status(_STATUS) == (1024 * 1024, 2048 * 1024)


def test_parse_proc_status_is_null_for_missing_fields() -> None:
    assert parse_proc_status("Name:\tpython\n") == (None, None)


@pytest.mark.parametrize("libc", [None, object()])
def test_mallinfo_and_trim_are_null_off_glibc(libc: Any) -> None:
    assert read_mallinfo(libc) is None
    assert trim_heap(libc) is None


def test_read_mallinfo_maps_the_named_fields() -> None:
    info = SimpleNamespace(arena=1, hblkhd=2, uordblks=3, fordblks=4, keepcost=5)
    libc = SimpleNamespace(mallinfo2=MagicMock(return_value=info))

    stats = read_mallinfo(libc)

    assert stats is not None
    assert stats.model_dump() == {"arena": 1, "hblkhd": 2, "uordblks": 3, "fordblks": 4, "keepcost": 5}


def test_read_mallinfo_reads_the_real_allocator_where_it_exists() -> None:
    libc = load_libc()
    if getattr(libc, "mallinfo2", None) is None:
        pytest.skip("this libc has no mallinfo2")

    stats = read_mallinfo(libc)

    assert stats is not None
    assert stats.uordblks > 0


@pytest.mark.parametrize(("returned", "released"), [(1, True), (0, False)])
def test_trim_heap_reports_whether_memory_was_released(returned: int, released: bool) -> None:
    trim = MagicMock(return_value=returned)

    assert trim_heap(SimpleNamespace(malloc_trim=trim)) is released
    trim.assert_called_once_with(0)


@pytest.mark.parametrize(
    ("filename", "expected"),
    [
        ("/app/.venv/lib/python3.14/site-packages/pydantic/main.py", "pydantic/main.py"),
        ("/a/site-packages/vendored/site-packages/pkg/mod.py", "pkg/mod.py"),
        ("C:\\venv\\Lib\\site-packages\\pkg\\mod.py", "pkg\\mod.py"),
        ("/app/src/gateway/main.py", "/app/src/gateway/main.py"),
        ("<frozen importlib._bootstrap>", "<frozen importlib._bootstrap>"),
    ],
)
def test_strip_site_packages(filename: str, expected: str) -> None:
    assert strip_site_packages(filename) == expected


def test_top_types_is_bounded_and_ordered() -> None:
    objects: list[object] = [1, 2, 3, "a", "b", 1.5]

    assert [(row.type, row.count) for row in top_types(objects, 2)] == [("int", 3), ("str", 2)]


def test_top_types_labels_are_bounded() -> None:
    long_named = type("X" * 500, (), {})

    assert all(len(row.type) <= 200 for row in top_types([long_named()], 1))


def _statistic(filename: str, lineno: int, size: int, count: int) -> Any:
    return SimpleNamespace(traceback=[SimpleNamespace(filename=filename, lineno=lineno)], size=size, count=count)


def test_traced_totals_keys_by_stripped_location_and_merges() -> None:
    totals = traced_totals(
        [
            _statistic("/venv-a/site-packages/pkg/mod.py", 7, 10, 1),
            _statistic("/venv-b/site-packages/pkg/mod.py", 7, 5, 2),
            _statistic("/app/x.py", 1, 3, 1),
        ]
    )

    assert totals == {"pkg/mod.py:7": (15, 3), "/app/x.py:1": (3, 1)}


def test_traced_totals_drops_excluded_files() -> None:
    totals = traced_totals(
        [_statistic("/app/own.py", 1, 10, 1), _statistic("/app/x.py", 2, 3, 1)], excluded={"/app/own.py"}
    )

    assert totals == {"/app/x.py:2": (3, 1)}


def test_by_file_merges_the_lines_of_each_file() -> None:
    merged = by_file({"pkg/a.py:1": (10, 1), "pkg/a.py:9": (5, 2), "pkg/b.py:3": (7, 1)})

    assert merged == {"pkg/a.py": (15, 3), "pkg/b.py": (7, 1)}


def test_top_allocations_is_bounded_and_ordered() -> None:
    rows = top_allocations({"a:1": (10, 1), "b:2": (30, 1), "c:3": (20, 1)}, 2)

    assert [row.location for row in rows] == ["b:2", "c:3"]


def test_top_growth_reports_only_growth_and_is_bounded() -> None:
    totals = {"grew:1": (30, 3), "new:2": (50, 5), "same:3": (9, 9), "shrank:4": (1, 1), "small:5": (11, 1)}
    baseline = {"grew:1": (10, 1), "same:3": (9, 9), "shrank:4": (5, 5), "small:5": (10, 1)}

    rows = top_growth(totals, baseline, 2)

    assert [(row.location, row.size_diff_bytes, row.count_diff) for row in rows] == [
        ("new:2", 50, 5),
        ("grew:1", 20, 2),
    ]


@pytest.fixture
def tracing() -> Any:
    tracemalloc.start()
    yield
    tracemalloc.stop()


@pytest.mark.usefixtures("tracing")
def test_baseline_is_taken_once_until_reset() -> None:
    service = MemoryDiagnosticsService()

    first = service._measure(5, False, False)
    second = service._measure(5, False, False)
    reset = service._measure(5, True, False)

    assert first.tracemalloc is not None
    assert first.tracemalloc.baseline_taken is True
    assert first.tracemalloc.top_growth == []
    assert second.tracemalloc is not None
    assert second.tracemalloc.baseline_taken is False
    assert reset.tracemalloc is not None
    assert reset.tracemalloc.baseline_taken is True
    assert reset.tracemalloc.top_growth == []


def test_measure_survives_a_platform_without_proc_or_glibc(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    monkeypatch.setattr(_memory_diagnostics, "_PROC_STATUS", tmp_path / "absent")
    monkeypatch.setattr(_memory_diagnostics, "load_libc", lambda: None)

    reading = MemoryDiagnosticsService()._measure(3, False, True)

    assert reading.rss_bytes is None
    assert reading.peak_rss_bytes is None
    assert reading.mallinfo is None
    assert reading.trim is None
    assert len(reading.top_types) == 3
